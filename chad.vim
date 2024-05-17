if exists("b:current_syntax")
    finish
endif

syn keyword chadKeyword if elif else is match to for in struct enum return break continue use voodoo
syn keyword chadType view slice void int list char str

syn match chadInt	"\v\d"
syn match chadStr "\v\".*\""
syn match chadChar "\v\'.*\'"
syn match chadIdent "\v[a-z\_0-9]"
syn match chadStruct "\v[A-Z][a-z0-9]*"
syn match chadFn "\v\zs[a-zA-Z|\_|0-9]+\ze\([^\)]*\)(\.[^\)]*\))?"

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
hi link chadType Type
hi link chadStruct Type
hi link chadComment	Comment
hi link chadOp Operator 
hi link chadInt Number
hi link chadStr String
hi link chadChar Character
hi link chadFn Function
hi link chadIdent Identifier

let b:current_syntax = "chad"
