# Chadscript

Zero overhead, high performance programming language focused on developer productivity.

## Prerequisites

ChadScript only runs on linux. Other platforms are currently being
implemented and tested.

Building ChadScript programs requires
- node
- clang

Dependencies are planned to be removed in the future. 

## Quick Start
#### Installation
```
git clone git@github.com:qwed81/chadscript.git
cd chadscript
npm install
npm run build
```
#### Hello World
```
# file 'main.chad'
fn main() int
  print("hello world")
  ret 0
```
#### Building and Running
```
chad main.chad
```

## Learning the Language

- [Langugage Features](https://qwed81.github.io/chadscript/#quick-start)
- [Compiler Configuration](https://qwed81.github.io/chadscript/#quick-start)
- [Examples](https://qwed81.github.io/chadscript/#quick-start)

## Contributing

ChadScript is still in an experimental phase. Any feedback is appriciated, especially
ideas for features of programming languages.



