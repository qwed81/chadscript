#include <stddef.h>

typedef struct _IO_FILE FILE;

FILE *fopen(const char *filename, const char *mode);

size_t fread(void *ptr, size_t size, size_t count, FILE *stream);

int fclose(FILE *stream);
