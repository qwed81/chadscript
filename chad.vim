" if exists("b:current_syntax")
"    finish
"endif

syn keyword chadKeyword while pri if elif else match for in struct enum return break continue use as include assert try get fn arena const cp mv trait
syn keyword chadType void int char bool num byte ptr str err i64 i32 i16 i8 u64 u32 u16 u8 f64 f32 


syn keyword chadNil nil

syn keyword chadBool false true

syn match chadInt	"\v\d"
syn match chadStr "\v\".*\""
syn match chadChar "\v\s\'.*\'"
syn match chadIdent "\v[a-z][a-zA-Z\_0-9']*"
syn match chadStruct "\v[A-Z][a-z0-9]*"
syn match chadFn "\v\zs[a-zA-Z|\_|0-9]+\ze\([^\)]*\)(\.[^\)]*\))?"

syn match chadFn "$[a-zA-Z0-9]*"

syn keyword chadOp is

syn match chadOp "\v\+"
syn match chadOp "\v\-"
syn match chadOp "\v\*"
syn match chadOp "\v\/"
syn match chadOp "\v\%"
syn match chadOp "\v\&"
syn match chadOp "\v\|"
syn match chadOp "\v\="
syn match chadOp "\v\<"
syn match chadOp "\v\>"
syn match chadOp "\v\!"
syn match chadOp "\v\["
syn match chadOp "\v\]"
syn match chadOp "\v\("
syn match chadOp "\v\)"
syn match chadOp "\v\{"
syn match chadOp "\v\}"

syn match chadComment "\v#.*$"
syn match chadComment "\v##(.|\n)*##"

hi link chadKeyword Keyword
hi link chadApply Keyword
hi link chadType Type
hi link chadStruct Type
hi link chadComment	Comment
hi link chadOp Operator 
hi link chadInt Number
hi link chadBool Number
hi link chadNil Number
hi link chadStr String
hi link chadChar Number
hi link chadFn Function
hi link chadIdent Identifier

let b:current_syntax = "chad"
