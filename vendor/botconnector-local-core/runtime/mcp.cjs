const {spawn}=require('node:child_process');

const MAX_LINE=1024*1024;
class McpClient{
  constructor(config={}){
    this.id=String(config.id||'');this.name=String(config.name||'mcp-server');this.command=String(config.command||'');this.args=Array.isArray(config.args)?config.args.map(String):[];this.enabled=config.enabled!==false;this.allowedTools=new Set(Array.isArray(config.allowedTools)?config.allowedTools.map(String):[]);this.timeoutMs=Math.min(30000,Math.max(250,Number(config.timeoutMs||5000)));this.child=null;this.nextId=1;this.pending=new Map();this.buffer='';
  }
  async start(){
    if(!this.enabled)throw new Error(`MCP server ${this.name} is disabled`);
    if(!this.command||this.command.includes('\u0000'))throw new Error('MCP command is required');
    if(this.child)return;
    this.child=spawn(this.command,this.args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdout.on('data',data=>this.#onData(data));
    this.child.stderr.on('data',()=>{}); // server diagnostics are never returned as tool output
    this.child.once('error',error=>this.#failPending(error));
    this.child.once('exit',(code,signal)=>{this.#failPending(new Error(`MCP server exited (${code??signal??'unknown'})`));this.child=null;});
    await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'BotConnector Core',version:'0.4.0'}});
    await this.notify('notifications/initialized',{});
  }
  async stop(){if(!this.child)return false;for(const p of this.pending.values())clearTimeout(p.timer);this.pending.clear();this.child.kill();this.child=null;return true;}
  async listTools(){await this.start();const result=await this.request('tools/list',{});return Array.isArray(result?.tools)?result.tools.filter(t=>typeof t?.name==='string'):[];}
  async callTool(toolName,args={}){
    if(!this.enabled)throw new Error(`MCP server ${this.name} is disabled`);
    if(!this.allowedTools.has(String(toolName)))throw new Error(`MCP tool is not allowlisted: ${toolName}`);
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('MCP tool arguments must be an object');
    await this.start();
    const result=await this.request('tools/call',{name:String(toolName),arguments:args});
    return{server:this.name,tool:String(toolName),result};
  }
  async notify(method,params){if(!this.child)throw new Error('MCP server is not running');this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
  request(method,params){
    if(!this.child)throw new Error('MCP server is not running');
    const id=this.nextId++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`MCP request timed out: ${method}`));},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});try{this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  }
  #onData(data){this.buffer+=String(data);if(this.buffer.length>MAX_LINE){this.#failPending(new Error('MCP response exceeded size limit'));this.buffer='';return;}let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}if(msg.id==null)continue;const p=this.pending.get(msg.id);if(!p)continue;this.pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(new Error(String(msg.error.message||'MCP request failed')));else p.resolve(msg.result);}}
  #failPending(error){for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(error);this.pending.delete(id);}}
}

function createMcpClients(config){return (Array.isArray(config)?config:[]).map(c=>new McpClient(c));}
module.exports={McpClient,createMcpClients};
