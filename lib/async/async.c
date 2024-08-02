#include "includes/async.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <stdbool.h>
#include <malloc.h>
#include <string.h>
#include <stdio.h>
#include <uv.h>

#define TASK_STACK_SIZE 1024 * 1024 * 3 
#define QUEUE_START_CAPACITY 1

typedef struct TaskArgs {
  void* routineArgs;
  void (*routine)(void*);
  void* stackStart;
} TaskArgs;

typedef struct TaskState {
  void* stackPtr;
  void* basePtr;
  void* continueAddr;
  TaskArgs* taskArgs;
} TaskState;

typedef struct Queue {
  void* items;
  size_t capacity;
  size_t itemSize;
  size_t len;
  uv_mutex_t mutex;
  uv_cond_t condvar;
  size_t head;
  size_t tail;
} Queue;

typedef struct StackRecycleNode {
  void* stackAddr;
  struct StackRecycleNode* next;
} StackRecycleNode;

typedef enum IORequestTag {
  FileOpen,
  FileWrite,
  FileRead,
  FileClose
} IORequestTag;

typedef struct FileOpenRequest {
  char* inName;
  FileHandle outHandle;
} FileOpenRequest;

typedef struct FileDataRequest {
  FileHandle inHandle;
  int outResult;
  uv_buf_t buf;
} FileDataRequest;

typedef struct IORequest {
  IORequestTag tag;
  TaskState returnToState;
  union {
    FileOpenRequest fileOpen;
    FileDataRequest fileRead;
    FileDataRequest fileWrite;
  };
} IORequest;

// Queue<TaskState>
Queue taskQueue;

// Queue<IORequest*>
Queue ioQueue;

_Thread_local StackRecycleNode* stackRecycle;
_Thread_local uv_loop_t* loop;

int initQueue(Queue* queue, size_t itemSize) {
  queue->items = malloc(QUEUE_START_CAPACITY * itemSize);
  queue->capacity = QUEUE_START_CAPACITY;
  queue->itemSize = itemSize;
  queue->len = 0;
  queue->head = 0;
  queue->tail = 0;

  int result = 0;
  result = uv_mutex_init(&queue->mutex);
  if (result < 0) {
    return result;
  }

  result = uv_cond_init(&queue->condvar);
  if (result < 0) {
    return result;
  }

  return 0;
}

__attribute__((sysv_abi))
void enqueue(Queue* queue, void* item) {
  uv_mutex_lock(&queue->mutex);

  memcpy(&queue->items[queue->tail * queue->itemSize], item, queue->itemSize);

  queue->tail += 1;
  if (queue->tail == queue->capacity) {
    queue->tail = 0;
  }

  queue->len += 1;
  if (queue->len == queue->capacity) {
    void* newItems = malloc(queue->capacity * 2 * queue->itemSize);
    for (size_t i = 0; i < queue->capacity; i++) {
      size_t index = (i + queue->head) % queue->capacity;
      memcpy(&newItems[i * queue->itemSize], &queue->items[index * queue->itemSize], queue->itemSize);
    }

    queue->head = 0;
    queue->tail = queue->capacity;
    queue->capacity = queue->capacity * 2;
    free(queue->items);
    queue->items = newItems;
  }

  uv_cond_signal(&queue->condvar);
  uv_mutex_unlock(&queue->mutex);
}

__attribute__((sysv_abi))
void dequeue(Queue* queue, void* output) {
  uv_mutex_lock(&queue->mutex);

  while (queue->len == 0) {
    uv_cond_wait(&queue->condvar, &queue->mutex);
  }

  memcpy(output, &queue->items[queue->head * queue->itemSize], queue->itemSize);
  queue->head += 1;
  if (queue->head == queue->capacity) {
    queue->head = 0;
  }

  queue->len -= 1;
  uv_mutex_unlock(&queue->mutex);
}

bool tryDequeue(Queue* queue, void* output) {
  bool hasElement = true;

  uv_mutex_lock(&queue->mutex);
  if (queue->len == 0) {
    hasElement = false;
  }
  else {
    memcpy(output, &queue->items[queue->head * queue->itemSize], queue->itemSize);

    queue->head += 1;
    if (queue->head == queue->capacity) {
      queue->head = 0;
    }
    queue->len -= 1;
  }
  uv_mutex_unlock(&queue->mutex);

  return hasElement;
}

__attribute__((sysv_abi, noinline))
void greenFnYield(IORequest* request, TaskState* saveToState);

__attribute__((sysv_abi, noinline))
void greenFnContinue();

__attribute__((sysv_abi))
void greenFnStart(TaskArgs* args) {
  args->routine(args->routineArgs);
  // TODO:
  // free stack
  greenFnContinue();
}

int startGreenFn(void (*routine)(void*), void* args) {
  void* newStack = NULL;

  if (newStack == NULL) {
    newStack = malloc(TASK_STACK_SIZE);
  }

  void* stackStart = newStack + TASK_STACK_SIZE - sizeof(void*);
  TaskArgs* taskArgs = malloc(sizeof(TaskArgs));
  taskArgs->routine = routine;
  taskArgs->routineArgs = args;

  TaskState taskState = {
    .stackPtr = stackStart,
    .basePtr = stackStart,
    .continueAddr = greenFnStart,
    .taskArgs = taskArgs
  };

  enqueue(&taskQueue, &taskState);
  return 0;
}

void onFileOpen(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  if (req->result >= 0) {
    ioReq->fileOpen.outHandle = req->result;
  }
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
}

void onFileRead(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  ioReq->fileRead.outResult = req->result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
}

void processIORequests() {
  IORequest* ioReq;
  uv_fs_t fsReq;
  
  bool hasElement = tryDequeue(&ioQueue, &ioReq);
  while (hasElement) {
    fsReq.data = ioReq;
    switch (ioReq->tag) {
      case FileOpen:
        uv_fs_open(loop, &fsReq, ioReq->fileOpen.inName, O_RDONLY, 0644, onFileOpen);
        break;
      case FileRead:
        uv_fs_read(loop, &fsReq, ioReq->fileRead.inHandle, &ioReq->fileRead.buf, 1, -1, onFileRead);
        break;
      case FileWrite:
        break;
      case FileClose:
        break;
    }
    hasElement = tryDequeue(&ioQueue, &ioReq);
  }
}

FileHandle openFile(char* name) {
  IORequest* request = malloc(sizeof(IORequest));
  request->tag = FileOpen;
  request->fileOpen.inName = name;

  greenFnYield(request, &request->returnToState);
  return request->fileOpen.outHandle;
}

int readFile(FileHandle handle, void* buf, int64_t bufSize) {
  IORequest request;
  request.tag = FileRead;
  request.fileRead.inHandle = handle;
  request.fileRead.buf = uv_buf_init(buf, bufSize);

  greenFnYield(&request, &request.returnToState);
  return request.fileRead.outResult;
}

void ioThreadStart(void* args) {
  uv_timer_t timer;
  loop = uv_default_loop();
  uv_timer_init(loop, &timer);
  uv_timer_start(&timer, processIORequests, 0, 5);

  uv_run(loop, UV_RUN_DEFAULT);
}

void workerThreadStart(void* args) {
  stackRecycle = NULL;
  greenFnContinue();
}

int initRuntime(int threadNum) {
  int result = 0;
  result = initQueue(&taskQueue, sizeof(TaskState));
  if (result < 0) {
    return result;
  }

  result = initQueue(&ioQueue, sizeof(IORequest*));
  if (result < 0) {
    return result;
  }

  // start the IO thread
  uv_thread_t threadHandle;
  result = uv_thread_create(&threadHandle, ioThreadStart, NULL);
  if (result < 0) {
    return result;
  }

  // start the worker threads
  for (int i = 0; i < threadNum; i++) {
    result = uv_thread_create(&threadHandle, workerThreadStart, NULL);
    if (result < 0) {
      return result;
    }
  }

  return 0;
}
