(function(){
  'use strict';
  const KEY='reposit.workspace.session.v1';
  const MAX_TABS=100;
  function clean(raw){
    if(!raw||typeof raw!=='object')return null;
    const tabs=[];const seen=new Set();
    for(const item of Array.isArray(raw.tabs)?raw.tabs:[]){
      const id=Number(item?.id||item);if(!Number.isInteger(id)||id<=0||seen.has(id))continue;
      seen.add(id);tabs.push({id,scrollTop:Math.max(0,Number(item?.scrollTop||0)),find:String(item?.find||'').slice(0,200)});
      if(tabs.length>=MAX_TABS)break;
    }
    const activeId=Number(raw.activeId||0);
    return {version:1,tabs,activeId:seen.has(activeId)?activeId:(tabs[0]?.id||0),savedAt:Number(raw.savedAt||0)};
  }
  function load(){try{return clean(JSON.parse(localStorage.getItem(KEY)||'null'));}catch(_){return null;}}
  function save(payload){const normalized=clean({...payload,savedAt:Date.now()});if(!normalized)return false;try{localStorage.setItem(KEY,JSON.stringify(normalized));return true;}catch(_){return false;}}
  function clear(){try{localStorage.removeItem(KEY);}catch(_){}}
  window.RepositWorkspace073={KEY,MAX_TABS,clean,load,save,clear};
})();
