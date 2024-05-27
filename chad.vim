" if exists("b:current_syntax")
"    finish
"endif

syn keyword chadKeyword while pub if elif else match for in struct enum return break continue use val
syn keyword chadType void int char bool

syn keyword chadBool false true

syn match chadInt	"\v\d"
syn match chadStr "\v\".*\""
syn match chadChar "\v\'.*\'"
syn match chadIdent "\v[a-z][a-zA-Z\_0-9]*"
syn match chadStruct "\v[A-Z][a-z0-9]*"
syn match chadFn "\v\zs[a-zA-Z|\_|0-9]+\ze\([^\)]*\)(\.[^\)]*\))?"

syn match chadApply "@[a-zA-Z0-9]*"

syn keyword chadOp is
syn keyword chadOp to

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

hi link chadKeyword Keyword
hi link chadApply Keyword
hi link chadType Type
hi link chadStruct Type
hi link chadComment	Comment
hi link chadOp Operator 
hi link chadInt Number
hi link chadBool Number
hi link chadStr String
hi link chadChar Number
hi link chadFn Function
hi link chadIdent Identifier

let b:current_syntax = "chad"
