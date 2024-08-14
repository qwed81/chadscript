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
#define BACKLOG 2000

typedef struct TaskArgs {
  void* routineArgs;
  void (*routine)(void*);
  void* stackStart;
  bool freeArgs;
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
  ReadDir,
  FileOpen,
  FileWrite,
  FileRead,
  FileClose,
  TcpListen,
  TcpConnect,
  TcpRead,
  TcpWrite,
  TcpClose,
  ProgramRun,
  ProgramWait,
  PipeRead,
  PipeWrite,
  PipeClose
} IORequestTag;

typedef struct ReadDirRequest {
  char* inPath;
  uv_dirent_t* files;
  size_t capacity;
  size_t index;
  int outResult;
} ReadDirRequest;

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

typedef struct TcpListenRequest {
  struct sockaddr_in addr;
  void* args;
  void (*handler)(TcpHandle handle, void* args);
  int outResult;
} TcpListenRequest;

typedef struct TcpConnectRequest {
  struct sockaddr_in addr;
  TcpHandle outHandle;
  int outResult;
} TcpConnectRequest;

typedef struct TcpDataRequest {
  TcpHandle inHandle;
  int outResult;
  uv_buf_t buf;
} TcpDataRequest;

typedef struct TcpCloseRequest {
  TcpHandle inHandle;
  int outResult;
} TcpCloseRequest;

typedef struct ProgramWaitState {
  TaskState exitReturnToState;
  // runs on the IO thread to avoid
  // race conditions
  int outExitCode;
  bool resumeOnWait;
  bool alreadyExited;
} ProgramWaitState;

typedef struct ProgramRunRequest {
  char** args;
  int outResult;
  ProgramWaitState* waitStateHandle;
  PipeHandle outStdoutHandle;
  PipeHandle outStdinHandle;
  PipeHandle outStderrHandle;
} RunProgramRequest;

typedef struct ProgramWaitRequest {
  ProgramWaitState* handle;
} ProgramWaitRequest;

typedef struct PipeDataRequest {
  PipeHandle inHandle;
  int outResult;
  uv_buf_t buf;
} PipeDataRequest;

typedef struct PipeCloseRequest {
  PipeHandle inHandle;
  int outResult;
} PipeCloseRequest;

typedef struct IORequest {
  IORequestTag tag;
  TaskState returnToState;
  union {
    ReadDirRequest readDir;
    FileOpenRequest fileOpen;
    FileDataRequest fileRead;
    FileDataRequest fileWrite;
    FileCloseRequest fileClose;
    TcpListenRequest tcpListen;
    TcpConnectRequest tcpConnect;
    TcpDataRequest tcpRead;
    TcpDataRequest tcpWrite;
    TcpCloseRequest tcpClose;
    RunProgramRequest programRun;
    ProgramWaitRequest programWait;
    PipeDataRequest pipeRead;
    PipeDataRequest pipeWrite;
    PipeDataRequest pipeClose;
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

  if (args->freeArgs) {
    free(args->routineArgs);
  }
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

int startGreenFn(void (*routine)(void*), void* args, bool freeArgs) {
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
  taskArgs->freeArgs = freeArgs;

  TaskState taskState = {
    .stackPtr = stackStart,
    .basePtr = stackStart,
    .continueAddr = greenFnStart,
    .taskArgs = taskArgs
  };

  enqueue(&taskQueue, &taskState);
  return 0;
}

void onScanDir(uv_fs_t* req) {
  IORequest* ioReq = req->data;
  int result = uv_fs_scandir_next(req, &ioReq->readDir.files[ioReq->readDir.index]);
  while (result >= 0 && result != UV_EOF) {
    ioReq->readDir.index += 1;
    // realloc if it needs to
    if (ioReq->readDir.index == ioReq->readDir.capacity) {
      ioReq->readDir.capacity *= 2;
      ioReq->readDir.files = realloc(ioReq->readDir.files, sizeof(uv_dirent_t) * ioReq->readDir.capacity);
    }
    result = uv_fs_scandir_next(req, &ioReq->readDir.files[ioReq->readDir.index]);
  }

  if (result != UV_EOF) {
    free(ioReq->readDir.files);
  }

  ioReq->readDir.outResult = result;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_fs_req_cleanup(req);
  free(req);
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

typedef struct TcpHandlerArgs {
  void* args;
  void (*routine)(TcpHandle handle, void* args);
  TcpHandle handle;
} TcpHandlerArgs;

void tcpHandler(TcpHandlerArgs* args) {
  args->routine(args->handle, args->args);
  free(args);
}

void onCloseTcpListenClient(uv_handle_t* client) {
  free(client);
}

void onTcpListenConnection(uv_stream_t* server, int status) {
  IORequest* ioReq = server->data;
  if (status < 0) {
    return;
  }

  uv_tcp_t* client = malloc(sizeof(uv_tcp_t));
  uv_tcp_init(loop, client);
  status = uv_accept(server, (uv_stream_t*)client);
  if (status < 0) {
    uv_close((uv_handle_t*)client, onCloseTcpListenClient);
    return;
  }

  TcpHandlerArgs* args = malloc(sizeof(TcpHandlerArgs));
  args->args = ioReq->tcpListen.args;
  args->handle = client;
  args->routine = ioReq->tcpListen.handler;
  startGreenFn((void*)tcpHandler, args, false);
}

void onTcpConnect(uv_connect_t* req, int status) {
  IORequest* ioReq = (IORequest*)req->data;
  ioReq->tcpConnect.outHandle = req->handle;
  ioReq->tcpConnect.outResult = status;
  enqueue(&taskQueue, &ioReq->returnToState);
  free(req);
}

// the buffer is already allocated and onTcpRead will call stop, so no new
// buffer needs to be allocated
void forwardBuf(uv_handle_t* handle, size_t suggestedSize, uv_buf_t* buf) {
  IORequest* ioReq = (IORequest*)handle->data;
  *buf = ioReq->tcpRead.buf;
}

void onTcpRead(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
  IORequest* ioReq = (IORequest*)stream->data;
  ioReq->tcpRead.outResult = nread;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_read_stop(stream);
}

void onTcpWrite(uv_write_t* req, int status) {
  IORequest* ioReq = (IORequest*)req->data;
  ioReq->tcpWrite.outResult = status;
  enqueue(&taskQueue, &ioReq->returnToState);
  free(req);
}

void onTcpClose(uv_handle_t* stream) {
  IORequest* ioReq = (IORequest*)stream->data;
  ioReq->tcpClose.outResult = 0;
  enqueue(&taskQueue, &ioReq->returnToState);
  free(stream);
}

void onProcExit(uv_process_t* proc, int64_t exitCode, int signal) {
  IORequest* ioReq = (IORequest*)proc->data;
  ProgramWaitState* waitHandle = ioReq->programRun.waitStateHandle;
  waitHandle->outExitCode = exitCode;
  waitHandle->alreadyExited = true;
  
  if (waitHandle->resumeOnWait) {
    enqueue(&taskQueue, &waitHandle->exitReturnToState);
  }

  free(ioReq);
  free(proc);
}

void onPipeRead(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
  IORequest* ioReq = (IORequest*)stream->data;
  ioReq->pipeRead.outResult = nread;
  enqueue(&taskQueue, &ioReq->returnToState);
  uv_read_stop(stream);
}

void onPipeWrite(uv_write_t* req, int status) {
  IORequest* ioReq = (IORequest*)req->data;
  ioReq->pipeWrite.outResult = status;
  enqueue(&taskQueue, &ioReq->returnToState);
  free(req);
}

void onPipeClose(uv_handle_t* stream) {
  IORequest* ioReq = (IORequest*)stream->data;
  ioReq->pipeClose.outResult = 0;
  enqueue(&taskQueue, &ioReq->returnToState);
  free(stream);
}

void processIORequests() {
  IORequest* ioReq;
  
  uv_fs_t* fsReq;
  uv_tcp_t* tcpReq;
  uv_connect_t* connectReq;
  uv_write_t* writeReq;
  uv_process_t* procReq;
  uv_process_options_t options;
  uv_stdio_container_t ioContainer[3];

  uv_pipe_t* stdoutPipe;
  uv_pipe_t* stdinPipe;
  uv_pipe_t* stderrPipe;

  int result;
  bool hasElement = tryDequeue(&ioQueue, &ioReq);
  while (hasElement) {
    switch (ioReq->tag) {
      case ReadDir:
        fsReq = malloc(sizeof(uv_fs_t));
        fsReq->data = ioReq;
        result = uv_fs_scandir(loop, fsReq, ioReq->readDir.inPath, 0, onScanDir);
        if (result < 0) {
          ioReq->readDir.outResult = result;
          enqueue(&taskQueue, &ioReq->returnToState);
        }
        break;
      case FileOpen:
        fsReq = malloc(sizeof(uv_fs_t));
        fsReq->data = ioReq;
        uv_fs_open(loop, fsReq, ioReq->fileOpen.inName, ioReq->fileOpen.flags, ioReq->fileOpen.mode, onFileOpen);
        break;
      case FileRead:
        fsReq = malloc(sizeof(uv_fs_t));
        fsReq->data = ioReq;
        uv_fs_read(loop, fsReq, ioReq->fileRead.inHandle, &ioReq->fileRead.buf, 1, ioReq->fileRead.position, onFileRead);
        break;
      case FileWrite:
        fsReq = malloc(sizeof(uv_fs_t));
        fsReq->data = ioReq;
        uv_fs_write(loop, fsReq, ioReq->fileWrite.inHandle, &ioReq->fileWrite.buf, 1, ioReq->fileWrite.position, onFileWrite);
        break;
      case FileClose:
        fsReq = malloc(sizeof(uv_fs_t));
        fsReq->data = ioReq;
        uv_fs_close(loop, fsReq, ioReq->fileClose.handle, onFileClose);
        break;
      case TcpListen:
        tcpReq = malloc(sizeof(uv_tcp_t));
        uv_tcp_init(loop, tcpReq);
        tcpReq->data = ioReq;

        result = uv_tcp_bind(tcpReq, (struct sockaddr*)&ioReq->tcpListen.addr, 0);
        if (result < 0) {
          ioReq->tcpListen.outResult = result;
          enqueue(&taskQueue, &ioReq->returnToState);
          free(tcpReq);
        }
        else {
          uv_listen((uv_stream_t*)tcpReq, BACKLOG, onTcpListenConnection);
        }
        break;
      case TcpConnect:
        tcpReq = malloc(sizeof(uv_tcp_t));
        connectReq = malloc(sizeof(uv_connect_t));
        connectReq->data = ioReq;
        uv_tcp_init(loop, tcpReq);
        uv_tcp_connect(connectReq, tcpReq, (struct sockaddr*)&ioReq->tcpConnect.addr, onTcpConnect);
        break;
      case TcpRead:
        ((uv_stream_t*)ioReq->tcpRead.inHandle)->data = ioReq;
        uv_read_start((uv_stream_t*)ioReq->tcpRead.inHandle, forwardBuf, onTcpRead);
        break;
      case TcpWrite:
        writeReq = malloc(sizeof(uv_write_t));
        writeReq->data = ioReq;
        uv_write(writeReq, ioReq->tcpWrite.inHandle, &ioReq->tcpWrite.buf, 1, onTcpWrite);
        break;
      case TcpClose:
        ((uv_handle_t*)ioReq->tcpClose.inHandle)->data = ioReq;
        uv_close(ioReq->tcpClose.inHandle, onTcpClose);
        break;
      case ProgramRun:
        stdoutPipe = malloc(sizeof(uv_pipe_t));
        stdinPipe = malloc(sizeof(uv_pipe_t));
        stderrPipe = malloc(sizeof(uv_pipe_t));

        uv_pipe_init(loop, stdoutPipe, 0);
        uv_pipe_init(loop, stdinPipe, 0);
        uv_pipe_init(loop, stderrPipe, 0);

        procReq = malloc(sizeof(uv_process_t));
        procReq->data = ioReq;

        memset(&options, 0, sizeof(uv_process_options_t));
        options.args = ioReq->programRun.args;
        options.file = ioReq->programRun.args[0];
        options.exit_cb = onProcExit;
        options.stdio_count = 3;
        options.stdio = ioContainer;
        options.stdio[0].flags = UV_CREATE_PIPE | UV_READABLE_PIPE;
        options.stdio[0].data.stream = (uv_stream_t*)stdinPipe;

        options.stdio[1].flags = UV_CREATE_PIPE | UV_WRITABLE_PIPE;
        options.stdio[1].data.stream = (uv_stream_t*)stdoutPipe;

        options.stdio[2].flags = UV_CREATE_PIPE | UV_WRITABLE_PIPE;
        options.stdio[2].data.stream = (uv_stream_t*)stderrPipe;

        ioReq->programRun.outStdoutHandle = stdoutPipe;
        ioReq->programRun.outStdinHandle = stdinPipe;
        ioReq->programRun.outStderrHandle = stderrPipe;

        ioReq->programRun.waitStateHandle = malloc(sizeof(ProgramWaitState));

        // can't resume before the program calls 'wait'
        ioReq->programRun.waitStateHandle->resumeOnWait = false;
        ioReq->programRun.waitStateHandle->alreadyExited = false;

        result = uv_spawn(loop, procReq, &options);
        ioReq->programRun.outResult = result;

        enqueue(&taskQueue, &ioReq->returnToState);
        break;
      case ProgramWait:
        if (ioReq->programWait.handle->alreadyExited) {
          // just resume and don't wait, because the program is ready
          enqueue(&taskQueue, &ioReq->programWait.handle->exitReturnToState);
        }
        else {
          // tell the callback to resume where it came from once it finishes
          ioReq->programWait.handle->resumeOnWait = true;
        }
        break;
      case PipeRead:
        ((uv_stream_t*)ioReq->pipeRead.inHandle)->data = ioReq;
        uv_read_start((uv_stream_t*)ioReq->pipeRead.inHandle, forwardBuf, onPipeRead);
        break;
      case PipeWrite:
        writeReq = malloc(sizeof(uv_write_t));
        writeReq->data = ioReq;
        uv_write(writeReq, ioReq->pipeWrite.inHandle, &ioReq->pipeWrite.buf, 1, onPipeWrite);
        break;
      case PipeClose:
        ((uv_handle_t*)ioReq->pipeClose.inHandle)->data = ioReq;
        uv_close(ioReq->pipeClose.inHandle, onPipeClose);
        break;
    }
    hasElement = tryDequeue(&ioQueue, &ioReq);
  }
}

ReadDirResult readDir(char* path) {
  IORequest request;
  request.tag = ReadDir;
  request.readDir.inPath = path;
  request.readDir.capacity = 4;
  request.readDir.index = 0;
  request.readDir.files = malloc(4 * sizeof(uv_dirent_t));

  greenFnYield(&request, &request.returnToState);
  ReadDirResult result;
  result.files = request.readDir.files;
  result.len = request.readDir.index;
  result.result = request.readDir.outResult;
  return result;
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

int listenTcp(char* host, int port, void* args, void (*handler)(TcpHandle handle, void* args)) {
  IORequest request;
  request.tag = TcpListen;
  uv_ip4_addr(host, port, &request.tcpListen.addr);
  request.tcpListen.args = args;
  request.tcpListen.handler = handler;

  greenFnYield(&request, &request.returnToState);
  return request.tcpListen.outResult;
}

int connectTcp(char* host, int port, TcpHandle* outHandle) {
  IORequest request;
  request.tag = TcpConnect;
  uv_ip4_addr(host, port, &request.tcpConnect.addr);

  greenFnYield(&request, &request.returnToState);
  *outHandle = request.tcpConnect.outHandle;
  return request.tcpConnect.outResult;
}

int readTcp(TcpHandle handle, void* buf, int64_t bufSize) {
  IORequest request;
  request.tag = TcpRead;
  request.tcpRead.inHandle = handle;
  request.tcpRead.buf = uv_buf_init(buf, bufSize);

  greenFnYield(&request, &request.returnToState);
  return request.tcpRead.outResult;
}
 
int writeTcp(TcpHandle handle, void* buf, int64_t bufSize) {
  IORequest request;
  request.tag = TcpWrite;
  request.tcpWrite.inHandle = handle;
  request.tcpWrite.buf = uv_buf_init(buf, bufSize);

  greenFnYield(&request, &request.returnToState);
  return request.tcpWrite.outResult;
}

int closeTcp(TcpHandle handle) {
  IORequest request;
  request.tag = TcpClose;
  request.tcpClose.inHandle = handle;

  greenFnYield(&request, &request.returnToState);
  return request.tcpWrite.outResult;
}

ChildResult runProgram(char** args) {
  IORequest* request = malloc(sizeof(IORequest));
  request->tag = ProgramRun;
  request->programRun.args = args;

  greenFnYield(request, &request->returnToState);

  ChildResult output;
  output.result = request->programRun.outResult;
  output.waitHandle = request->programRun.waitStateHandle;
  output.stdoutHandle = request->programRun.outStdoutHandle;
  output.stdinHandle = request->programRun.outStdinHandle;
  output.stderrHandle = request->programRun.outStderrHandle;
  return output;
}

int waitProgram(ProgramWaitState* handle) {
  IORequest request;
  request.tag = ProgramWait;
  request.programWait.handle = handle;

  // store the return to state to handle so that when exit is called it returns here
  greenFnYield(&request, &request.programWait.handle->exitReturnToState);
  return request.programWait.handle->outExitCode;
}

int readPipe(PipeHandle handle, void* buf, int64_t bufSize) {
  IORequest request;
  request.tag = PipeRead;
  request.pipeRead.inHandle = handle;
  request.pipeRead.buf = uv_buf_init(buf, bufSize);

  greenFnYield(&request, &request.returnToState);
  return request.pipeRead.outResult;
}

int writePipe(PipeHandle handle, void* buf, int64_t bufSize) {
  IORequest request;
  request.tag = PipeWrite;
  request.pipeWrite.inHandle = handle;
  request.pipeWrite.buf = uv_buf_init(buf, bufSize);

  greenFnYield(&request, &request.returnToState);
  return request.pipeWrite.outResult;
}

int closePipe(PipeHandle handle) {
  IORequest request;
  request.tag = PipeClose;
  request.pipeClose.inHandle = handle;

  greenFnYield(&request, &request.returnToState);
  return request.pipeClose.outResult;
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
