extern taskQueue
extern ioQueue

extern enqueue
extern dequeue

global greenFnYield
global greenFnContinue

section .text
greenFnYield:
  ; save the current state
  ; leave taskArgs uninit
  pop rdx ; the return address

  mov [rsi], rsp
  mov [rsi + 8], rbp
  mov [rsi + 16], rdx ; continue to the return address

  sub rsp, 8
  mov rsi, rsp 
  mov [rsp], rdi ; save the request (IORequest*)
  lea rdi, [rel ioQueue]

  ; keep aligned
  sub rsp, 8

  call enqueue ; enqueue(&ioQueue, &request (IORequest**))
  add rsp, 16

  sub rsp, 32
  mov rsi, rsp
  lea rdi, [rel taskQueue]
  ; reserve space for the task
  call dequeue ; dequeue(&taskQueue, &rsp)

  add rsp, 32
  mov rbp, [rsp - 24] ; set the base pointer 
  mov rsi, [rsp - 16] ; save the continue addr
  mov rdi, [rsp - 8] ; taskArgs for greenFnStart
  mov rsp, [rsp - 32] ; set the stack addr

  jmp rsi ; continue

greenFnContinue:
  pop rdi

  sub rsp, 32
  mov rsi, rsp
  lea rdi, [rel taskQueue]
  ; reserve space for the task
  call dequeue ; dequeue(&taskQueue, &rsp)

  add rsp, 32
  mov rbp, [rsp - 24] ; set the base pointer 
  mov rsi, [rsp - 16] ; save the continue addr
  mov rdi, [rsp - 8] ; taskArgs for greenFnStart
  mov rsp, [rsp - 32] ; set the stack addr

  jmp rsi ; continue
