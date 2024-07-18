## Overview
### Simplicity
Chadscript is a psudo-systems language made to be the high level half with C
or assembly being the low level half. It is intentionally designed to be a fast
programming language with a small runtime with a very restrictive syntax for
the purpose of simplicity. Chadscript targets the 99% use case and has limited support
for memory managment. The libraries are made to be fast and trivial,
yet powerful. A 1% use case is not supported in the standard library on purpose
to simplify.

### Speed and Memory Safety
Chadscript performs memory managment by reference counting heap allocations. Note that
most of these will be optimized away in trivial cases that a RAII/Borrow Checker algorithm
could allow anyways. Additionally shared pointers will be referenced counted in cases
with non-trivial lifetimes similar to C++ std::shared_ptr. Additionally structs are
not treated as references like Java or C#. They are defined as C structs and behave
the same way including in stack and heap allocations. Combined this gives the performance
of systems languages while not having to worry about pointers or memory managment.

### The 1% Use Cases
Although it would be lovely to have all programs fit into nice algoithms and perfect libraries
the reality is sometimes the code gets dirty. Some assembly here, some pointers there, some
manual SIMD to get the last bit of performance from a hot spot in a tripple nested for loop.
In the spirit of applying the right tool for the job, and to not destroy the simplicity of
Chadscript, these cases can be handled by C. Chadscript compiles to C instead of LLVM for this
exact reason. Take a pointer to a value mid way though the function and call you assembly
function to set the program in the exact state you want it. No control is lost even when
your app sometimes needs to do something unintuitive

## Usage
### Quick Start
Currently there is no build system so files must be passed to the compiler directly.
Note that you must have clang and node installed
```
git clone git@github.com:qwed81/chadscript.git
cd chadscript
cp lib/ myCode/
cd myCode
echo "use std\nmain()\nprint("hello world!")" >> example.chad
npm run start -- -o ../build/output.c lib && clang ../build/output.c -o ../build/output
```

## Language Specification
It is recommended to know at least one typesafe programming language. 

### Types
```
int # 64 bit integer
num # 64 bit floating point
int[] # a constant array of integers (ref counted)
int[&] # a mutable array of integers (ref counted)
char[] # a constant string
char[&] # mutable string
int* # same as int[&], used for documenting a length of 1, used for shared access
int(int) # a function that takes a single int and returns an int
int? # a some(int) or none
int! # a ok(int) or err(char[])
# some useful collections - note List[int] means generic int
List[int] # array list
StrBuf # used to build strings efficiently
Map[int, int] # hash map
```

### Structs and Enums
Structs and Enums are both defined and used in similar ways
```
struct Point
  int x
  int y

enum HttpBody
  char[] json
  char[] form
```
They can be used with the dot operator and struct init
```
Point p = { x = 0, y = 10 }
print(p.x)
HttpBody responseBody = json("[\"hello\"]")
print(responseBody.json)
```
Enums are defined as tagged unions, so it can only be one value at a time
The dot operator on enums can only be used in a situation where the enum
is that type, which can be done by just using if statements
```
if responseBody is json
  print(responseBody.json)
```
### Error and result handling
```
# using optional values
int? a = some(10)
a = none
int b = a.some
  if a is none
    print("no value there")

# using errors
int! c = ok(10)
c = err("something went wrong")
int d = c.ok 
if a is err
  print(a.err)

# if a function returns a value you can 'try'
main() void!
  File f = try open("text.txt")

  # which is defined as
  File! f1 = open("text.txt")
  File newFile
  if f1 is err
    return err(f1.err)
  else
    newFile = f1.ok

# assert will crash the program if it is an error
main() void!
  File f = assert open("text.txt")
  # additionally assert can be used with bools
  assert 1 == 1
```

### Functions
Unlike other languages there is no such thing as functions implemented on types,
or constructors, or even casting. Everything is done with a standard function which
not only simplifies the language but adds cool features
Additionally functions can be overloaded based on both param types and return types.
This is what it looks like in practice:
```
main()
  List[int] myList = list()
  add(myList, 10)
  print(myList)
```
Additionally functions can use generics by naming a type an uppercase letter. Instead of
having traits or interfaces you can resolve a function at call time. For example you can't
print a type that can't be turned into a string, but if you pass a function that can turn
it into a string, there is no problem, just use that function.
```
print(T val, char[](T) tToStr=toStr)
  ...
```
Note that functions as default parameters are resolved at call time, so the toStr implementation
is based on the scope of the callee. It will actually resolve the proper implementation based on
the generics, and error if ambiguous. You can also pass in different implementations to the same
function
```
customStrFn(int a) char[]
  return toStr(a + a)

main()
  # using default 'tToStr=toStr'
  print(1)

  # supplying custom 'tToStr'
  print(1, tToStr=customStrFn)
```

