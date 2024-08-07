#include <stdint.h>

typedef int FileHandle;

int startGreenFn(void (*start)(void*), void* args);

int initRuntime(int threadNum);

int startThread(void (*start)(void*), void* args);

FileHandle openFile(char* name, int flags, int mode);

int writeFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int readFile(FileHandle handle, void* buf, int64_t bufSize, int64_t position);

int closeFile(FileHandle handle);
 
