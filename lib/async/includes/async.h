#include <uv.h>
#include <stdint.h>
#include <stdbool.h>

typedef int FileHandle;
typedef void* TcpHandle;
typedef void* PipeHandle;
struct ProgramWaitState;

typedef struct ChildResult {
  int result;
  PipeHandle stdoutHandle;
  PipeHandle stdinHandle;
  PipeHandle stderrHandle;
  struct ProgramWaitState* waitHandle;
} ChildResult;

typedef struct ReadDirResult {
  uv_dirent_t* files;
  size_t len;
  int result;
} ReadDirResult;

int startGreenFn(void (*start)(void*), void* args, bool freeArgs);

int initRuntime(int threadNum);

int startThread(void (*start)(void*), void* args);

ReadDirResult readDir(char* path);

FileHandle openFile(char* name, int flags, int mode);

int writeFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int readFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int closeFile(FileHandle handle);

int listenTcp(char* host, int port, void* args, void (*handler)(TcpHandle handle, void* args));

int connectTcp(char* host, int port, TcpHandle* outHandle);

int readTcp(TcpHandle handle, void* buf, int64_t bufSize);
 
int writeTcp(TcpHandle handle, void* buf, int64_t bufSize);

int closeTcp(TcpHandle handle);

ChildResult runProgram(char** args);

int waitProgram(struct ProgramWaitState* waitStateHandle);

int readPipe(PipeHandle handle, void* buf, int64_t bufSize);

int writePipe(PipeHandle handle, void* buf, int64_t bufSize);

int closePipe(PipeHandle handle);
