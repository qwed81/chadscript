extern taskQueue
extern ioQueue

extern enqueue
extern dequeue

global greenFnYield
global greenFnContinue

section .text
greenFnYield:
  pop rdx ; the return address

  ; save the current state that can not be clobbered
  mov [rsi], rsp
  mov [rsi + 8], rbp
  mov [rsi + 16], rdx ; continue to the return address
  ; leave taskArgs uninit
  mov [rsi + 32], rbx
  mov [rsi + 40], r12
  mov [rsi + 48], r13
  mov [rsi + 56], r14
  mov [rsi + 64], r15

  sub rsp, 8
  mov rsi, rsp 
  mov [rsp], rdi ; save the request (IORequest*)
  lea rdi, [rel ioQueue]

  ; keep aligned
  sub rsp, 8

  call enqueue ; enqueue(&ioQueue, &request (IORequest**))
  add rsp, 16

  sub rsp, 80
  mov rsi, rsp
  lea rdi, [rel taskQueue]
  ; reserve space for the task
  call dequeue ; dequeue(&taskQueue, &rsp)

  add rsp, 80

  ; restore the state of the previous task
  mov rbp, [rsp - 72] ; set the base pointer 
  mov rsi, [rsp - 64] ; save the continue addr
  mov rdi, [rsp - 56] ; taskArgs for greenFnStart
  mov rbx, [rsp - 48] ; rbx
  mov r12, [rsp - 40] ; r12
  mov r13, [rsp - 32] ; r13
  mov r14, [rsp - 24] ; r14
  mov r15, [rsp - 16] ; r15
  mov rsp, [rsp - 80] ; set the stack addr

  jmp rsi ; continue

greenFnContinue:
  pop rdi

  sub rsp, 80
  mov rsi, rsp
  lea rdi, [rel taskQueue]
  ; reserve space for the task
  call dequeue ; dequeue(&taskQueue, &rsp)

  add rsp, 80

  ; restore the state of the previous task
  mov rbp, [rsp - 72] ; set the base pointer 
  mov rsi, [rsp - 64] ; save the continue addr
  mov rdi, [rsp - 56] ; taskArgs for greenFnStart
  mov rbx, [rsp - 48] ; rbx
  mov r12, [rsp - 40] ; r12
  mov r13, [rsp - 32] ; r13
  mov r14, [rsp - 24] ; r14
  mov r15, [rsp - 16] ; r15
  mov rsp, [rsp - 80] ; set the stack addr

  jmp rsi ; continue
