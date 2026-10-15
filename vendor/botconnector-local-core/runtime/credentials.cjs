// Cloud provider credential resolution for BotConnector Core.
// Resolution order: safeStorage (Desktop/Windows) -> environment fallback -> MISSING.
// Plaintext key material NEVER leaves this module boundary as a return value of
// logging/serialization APIs: getters return key strings only to callers that
// make provider HTTP calls; public() exposes configured-state booleans only.
// Encrypted blobs live in the Store (settings.json) as base64 safeStorage blobs.
const PROVIDERS=['nebius','together'];
const ENV_NAMES={
  nebius:['NEBIUS_API_KEY','NEBIUS_TOKEN','NEBIUS_TOKEN_FACTORY_API_KEY'],
  together:['TOGETHER_API_KEY','TOGETHER_AI_API_KEY']
};
const STORE_FIELD={nebius:'cloudKeyNebiusEncrypted',together:'cloudKeyTogetherEncrypted'};

class CredentialManager{
  constructor({store,safeStorage=null,env=process.env}={}){
    this.store=store;this.safeStorage=safeStorage;this.env=env;
  }
  setSafeStorage(safeStorage){this.safeStorage=safeStorage;}
  encryptionAvailable(){
    if(this.safeStorage&&typeof this.safeStorage.isEncryptionAvailable==='function')return Boolean(this.safeStorage.isEncryptionAvailable());
    return false;
  }
  encrypt(plain){
    if(!this.encryptionAvailable())throw new Error('Credential encryption is unavailable in this process');
    return this.safeStorage.encryptString(String(plain)).toString('base64');
  }
  decrypt(enc){
    if(!enc)return '';
    if(!this.encryptionAvailable())throw new Error('Credential decryption is unavailable in this process');
    try{return this.safeStorage.decryptString(Buffer.from(String(enc),'base64'));}catch{return '';}
  }
  source(provider){
    const p=String(provider||'').toLowerCase();
    if(!PROVIDERS.includes(p))throw new Error(`Unknown cloud provider: ${provider}`);
    // 1. safeStorage blob persisted in Store
    const enc=this.store.get(STORE_FIELD[p]);
    if(enc){
      let plain='';try{plain=this.decrypt(enc);}catch{plain='';}
      if(plain)return {source:'safeStorage',key:plain};
    }
    // 2. environment fallback (development/CI)
    for(const name of ENV_NAMES[p]){
      const v=this.env[name];
      if(v&&String(v).trim())return {source:'environment',key:String(v).trim(),envName:name};
    }
    return {source:'missing',key:''};
  }
  has(provider){return this.source(provider).source!=='missing';}
  sourceLabel(provider){return this.source(provider).source;}
  async setKey(provider,plain){
    const p=String(provider||'').toLowerCase();
    if(!PROVIDERS.includes(p))throw new Error(`Unknown cloud provider: ${provider}`);
    const value=String(plain||'').replace(/\r?\n/g,'').trim();
    if(value.length<8)throw new Error('API key looks too short');
    if(!this.encryptionAvailable())throw new Error('Windows credential encryption (safeStorage) is unavailable; refusing to store a plaintext key');
    await this.store.set(STORE_FIELD[p],this.encrypt(value));
    return {provider:p,configured:true,source:'safeStorage'};
  }
  async removeKey(provider){
    const p=String(provider||'').toLowerCase();
    if(!PROVIDERS.includes(p))throw new Error(`Unknown cloud provider: ${provider}`);
    await this.store.set(STORE_FIELD[p],'');
    const stillEnv=ENV_NAMES[p].some(n=>this.env[n]);
    return {provider:p,configured:this.has(p),source:this.sourceLabel(p),note:stillEnv?`${ENV_NAMES[p][0]} remains available via environment fallback`:''};
  }
  // Public, serializable state. NEVER contains key material.
  public(){
    const result={};
    for(const p of PROVIDERS){
      const s=this.source(p);
      result[p]={configured:s.source!=='missing',source:s.source,envName:s.envName||null};
    }
    result.safeStorageAvailable=this.encryptionAvailable();
    return result;
  }
}
module.exports={CredentialManager,PROVIDERS,ENV_NAMES,STORE_FIELD};