" if exists("b:current_syntax")
"    finish
"endif

syn keyword chadKeyword while pri if elif else for in struct enum ret break continue use as include assert try get fn const decl recur impl with local macro field defer union
syn keyword chadType void int char bool ptr str err i64 i32 i16 i8 u64 u32 u16 u8 f64 f32 seg vec
syn keyword chadNil nil
syn keyword chadBool false true

syntax region chadStr start=/"/ skip=/\\"/ end=/"/ contains=expressionBlock
syntax region expressionBlock start=/{/ end=/}/ contained

syn match chadInt	"\v\d"
syn match chadChar "\v\'([^\']*)\'"
syn match chadIdent "\v[a-z][a-zA-Z\_0-9']*"
syn match chadStruct "\v[A-Z][a-z0-9]*"
syn match chadFn "\v\zs[a-zA-Z|\_|0-9]+\ze\([^\)]*\)(\.[^\)]*\))?"
syn match chadMacro "@\v\zs[a-zA-Z|\_|0-9]+\ze\([^\)]*\)(\.[^\)]*\))?"
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
syntax region chadCommentBlock start=/##/ end=/##/ keepend

hi link chadStr String
hi link chadMacro Keyword
hi link chadKeyword Keyword
hi link chadApply Keyword
hi link chadType Type
hi link chadStruct Type
hi link chadComment	Comment
hi link chadCommentBlock Comment
hi link chadOp Operator 
hi link chadInt Number
hi link chadBool Number
hi link chadNil Number
hi link chadChar Number
hi link chadFn Function
hi link chadFnTrait Function
hi link chadIdent Identifier

let b:current_syntax = "chad"
