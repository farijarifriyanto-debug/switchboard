const MAX_EXPRESSION_LENGTH=256;

const TOOL_DEFINITIONS=[{
  type:'function',
  function:{
    name:'calculator',
    description:'Evaluate a basic arithmetic expression using numbers, parentheses, +, -, *, /, and %. Use this for exact calculations.',
    parameters:{type:'object',properties:{expression:{type:'string',description:'Arithmetic expression, for example 27 + 15'}},required:['expression'],additionalProperties:false}
  }
}];

function tokenize(expression){
  const tokens=[];let i=0;
  while(i<expression.length){
    if(/\s/.test(expression[i])){i++;continue;}
    const number=expression.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if(number){tokens.push({type:'number',value:Number(number[0])});i+=number[0].length;continue;}
    if('+-*/%()'.includes(expression[i])){tokens.push({type:expression[i],value:expression[i]});i++;continue;}
    throw new Error('Only numeric arithmetic is allowed');
  }
  if(!tokens.length)throw new Error('Expression is empty');
  return tokens;
}

function calculate(expression){
  expression=String(expression??'').trim();
  if(!expression||expression.length>MAX_EXPRESSION_LENGTH)throw new Error('Invalid calculator expression');
  const t=tokenize(expression);let i=0;
  const primary=()=>{
    if(t[i]?.type==='+'||t[i]?.type==='-'){const sign=t[i++].type==='-'?-1:1;return sign*primary();}
    if(t[i]?.type==='number')return t[i++].value;
    if(t[i]?.type==='('){i++;const v=additive();if(t[i]?.type!==')')throw new Error('Unbalanced parentheses');i++;return v;}
    throw new Error('Expected a number');
  };
  const multiplicative=()=>{let v=primary();while(['*','/','%'].includes(t[i]?.type)){const op=t[i++].type,b=primary();if((op==='/'||op==='%')&&b===0)throw new Error('Division by zero');v=op==='*'?v*b:op==='/'?v/b:v%b;}return v;};
  const additive=()=>{let v=multiplicative();while(['+','-'].includes(t[i]?.type)){const op=t[i++].type,b=multiplicative();v=op==='+'?v+b:v-b;}return v;};
  const value=additive();
  if(i!==t.length)throw new Error('Malformed calculator expression');
  if(!Number.isFinite(value))throw new Error('Calculator result is not finite');
  return value;
}

function parseArguments(raw){
  if(raw&&typeof raw==='object'&&!Array.isArray(raw))return raw;
  if(typeof raw!=='string'||raw.length>2048)throw new Error('Tool arguments must be a small JSON object');
  let parsed;try{parsed=JSON.parse(raw);}catch{throw new Error('Tool arguments are not valid JSON');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Tool arguments must be a JSON object');
  return parsed;
}

function executeAllowedTool(call){
  const name=call?.function?.name||call?.name;
  if(name!=='calculator')return{ok:false,tool:name||'unknown',error:'Tool is not allowlisted'};
  try{
    const args=parseArguments(call?.function?.arguments??call?.input);
    if(typeof args.expression!=='string')throw new Error('calculator.expression must be a string');
    const value=calculate(args.expression);
    return{ok:true,tool:'calculator',result:{expression:args.expression,value,formatted:String(value)}};
  }catch(error){return{ok:false,tool:'calculator',error:String(error.message||error)}}
}

module.exports={TOOL_DEFINITIONS,calculate,executeAllowedTool,parseArguments};
