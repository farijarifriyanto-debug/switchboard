const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

class Store{
  constructor(userData){this.userData=userData;this.file=path.join(userData,'settings.json');this.data=null;}
  defaults(){return {modelsDir:path.join(os.homedir(),'BotConnector AI','models'),runtimeBackend:'auto',language:'system',hfTokenEncrypted:'',apiAuthEnabled:false,apiTokenEncrypted:'',mcpServers:[]};}
  load(){if(this.data)return this.data;try{this.data={...this.defaults(),...JSON.parse(fs.readFileSync(this.file,'utf8'))};}catch{this.data=this.defaults();}return this.data;}
  get(k){return this.load()[k];}
  async set(k,v){this.load()[k]=v;await fsp.mkdir(this.userData,{recursive:true});await fsp.writeFile(this.file,JSON.stringify(this.data,null,2));return this.data;}
  public(){const d={...this.load()};delete d.hfTokenEncrypted;delete d.apiTokenEncrypted;d.hfToken=d.hfToken?'••••••••':'';d.apiTokenConfigured=Boolean(this.load().apiTokenEncrypted);return d;}
}
module.exports={Store};
