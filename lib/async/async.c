#include "includes/async.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <stdbool.h>
#include <malloc.h>
#include <string.h>
#include <stdio.h>
#include <uv.h>

#include <sys/mman.h>

#define TASK_STACK_SIZE 1024 * 1024
#define QUEUE_START_CAPACITY 1000

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
  uint64_t rbx;
  uint64_t r12;
  uint64_t r13;
  uint64_t r14;
  uint64_t r15; 
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
  int flags;
  int mode;
  FileHandle outHandle;
} FileOpenRequest;

typedef struct FileDataRequest {
  FileHandle inHandle;
  int outResult;
  int64_t position;
  uv_buf_t buf;
} FileDataRequest;

typedef struct FileCloseRequest {
  FileHandle handle;
  int outResult;
} FileCloseRequest;

typedef struct IORequest {
  IORequestTag tag;
  TaskState returnToState;
  union {
    FileOpenRequest fileOpen;
    FileDataRequest fileRead;
    FileDataRequest fileWrite;
    FileCloseRequest fileClose;
  };
} IORequest;

// Queue<TaskState>
Queue taskQueue;

// Queue<IORequest*>
Queue ioQueue;

_Thread_local StackRecycleNode* stackRecycle = NULL;
_Thread_local uv_loop_t* loop = NULL;

_Atomic int globalThreadCount = 0;
_Thread_local uint64_t threadId = -1;
_Thread_local bool isGreenFn = false;

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

  if (queue->itemSize == sizeof(TaskState)) {
    TaskState* i = (TaskState*)item;
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
  if (queue->itemSize == sizeof(TaskState)) {
    TaskState* item = (TaskState*)output;
  }
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

  // recycle the stack so it can still be used with free
  StackRecycleNode* node = malloc(sizeof(StackRecycleNode));
  node->next = stackRecycle;
  node->stackAddr = args->stackStart;
  stackRecycle = node;

  free(args->routineArgs);
  free(args);
  greenFnContinue();
}

void* allocStack() {
  int prot = PROT_READ | PROT_WRITE;
  int mode = MAP_PRIVATE | MAP_ANONYMOUS | MAP_GROWSDOWN;
  void* stack = mmap(NULL, TASK_STACK_SIZE, prot, mode, -1, 0);
  return stack; 
}

void freeStack(void* stack) {
  munmap(stack, TASK_STACK_SIZE);
}

int startGreenFn(void (*routine)(void*), void* args) {
  void* newStack = NULL;

  if (stackRecycle == NULL) {
    newStack = allocStack();
  }
  else {
    newStack = stackRecycle->stackAddr;
    StackRecycleNode* oldStackRecycle = stackRecycle;
    stackRecycle = stackRecycle->next;
    free(oldStackRecycle);
  }

  void* stackStart = newStack + TASK_STACK_SIZE - sizeof(void*);
  TaskArgs* taskArgs = malloc(sizeof(TaskArgs));
  taskArgs->routine = routine;
  taskArgs->routineArgs = args;
  taskArgs->stackStart = stackStart;

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
  ioReq->fileOpen.outHandle = req->result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
  free(req);
}

void onFileRead(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  ioReq->fileRead.outResult = req->result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
  free(req);
}

void onFileWrite(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  ioReq->fileWrite.outResult = req->result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
  free(req);
}

void onFileClose(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  ioReq->fileClose.outResult = req->result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
  free(req);
}

void processIORequests() {
  IORequest* ioReq;
  
  bool hasElement = tryDequeue(&ioQueue, &ioReq);
  while (hasElement) {
    uv_fs_t* fsReq = malloc(sizeof(uv_fs_t));
    fsReq->data = ioReq;
    switch (ioReq->tag) {
      case FileOpen:
        uv_fs_open(loop, fsReq, ioReq->fileOpen.inName, ioReq->fileOpen.flags, ioReq->fileOpen.mode, onFileOpen);
        break;
      case FileRead:
        uv_fs_read(loop, fsReq, ioReq->fileRead.inHandle, &ioReq->fileRead.buf, 1, ioReq->fileRead.position, onFileRead);
        break;
      case FileWrite:
        uv_fs_write(loop, fsReq, ioReq->fileWrite.inHandle, &ioReq->fileWrite.buf, 1, ioReq->fileWrite.position, onFileWrite);
        break;
      case FileClose:
        uv_fs_close(loop, fsReq, ioReq->fileClose.handle, onFileClose);
        break;
    }
    hasElement = tryDequeue(&ioQueue, &ioReq);
  }
}

FileHandle openFile(char* name, int flags, int mode) {
  IORequest request;
  request.tag = FileOpen;
  request.fileOpen.inName = name;
  request.fileOpen.flags = flags;
  request.fileOpen.mode = mode;

  greenFnYield(&request, &request.returnToState);
  return request.fileOpen.outHandle;
}

int readFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position) {
  IORequest request;
  request.tag = FileRead;
  request.fileRead.inHandle = handle;
  request.fileRead.buf = uv_buf_init(buf, bufSize);
  request.fileRead.position = position;

  greenFnYield(&request, &request.returnToState);
  return request.fileRead.outResult;
}

int writeFile(FileHandle handle, void* bytes, int64_t bufSize, int64_t position) {
  IORequest request;
  request.tag = FileWrite;
  request.fileWrite.inHandle = handle;
  request.fileWrite.buf = uv_buf_init(bytes, bufSize);
  request.fileWrite.position = position;

  greenFnYield(&request, &request.returnToState);
  return request.fileWrite.outResult;
}

int closeFile(FileHandle handle) {
  IORequest request;
  request.tag = FileClose;
  request.fileClose.handle = handle;

  greenFnYield(&request, &request.returnToState);
  return request.fileClose.outResult;
}

void ioThreadStart(void* args) {
  uv_timer_t timer;
  loop = uv_default_loop();
  uv_timer_init(loop, &timer);
  uv_timer_start(&timer, processIORequests, 0, 5);

  uv_run(loop, UV_RUN_DEFAULT);
}

int startThread(void (*start)(void*), void* args) {
  uv_thread_t threadHandle;
  threadId = atomic_fetch_add_explicit(&globalThreadCount, 1, memory_order_relaxed);
  return uv_thread_create(&threadHandle, start, args);
}

void workerThreadStart(void* args) {
  isGreenFn = true;
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
  result = startThread(ioThreadStart, NULL);
  if (result < 0) {
    return result;
  }

  // start the worker threads
  for (int i = 0; i < threadNum; i++) {
    result = startThread(workerThreadStart, NULL);
    if (result < 0) {
      return result;
    }
  }

  return 0;
}
