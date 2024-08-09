#include <stdint.h>

typedef int FileHandle;
typedef void* TcpHandle;

int startGreenFn(void (*start)(void*), void* args);

int initRuntime(int threadNum);

int startThread(void (*start)(void*), void* args);

FileHandle openFile(char* name, int flags, int mode);

int writeFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int readFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int closeFile(FileHandle handle);

int listenTcp(char* host, int port, void* args, void (*handler)(TcpHandle handle, void* args));

int connectTcp(char* host, int port, TcpHandle* outHandle);

int readTcp(TcpHandle handle, void* buf, int64_t bufSize);
 
int writeTcp(TcpHandle handle, void* buf, int64_t bufSize);

int closeTcp(TcpHandle handle);
