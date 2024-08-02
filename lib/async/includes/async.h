#include <stdint.h>

typedef int FileHandle;

int startGreenFn(void (*start)(void*), void* args);

int initRuntime(int threadNum);

FileHandle openFile(char* name);

int writeFile(FileHandle handle, void* buf, int64_t bufSize);

int readFile(FileHandle handle, void* buf, int64_t bufSize);

void closeFile(FileHandle handle);
 
