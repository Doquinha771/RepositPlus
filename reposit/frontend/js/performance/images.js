(function(){
  'use strict';
  class ObjectUrlRegistry{
    constructor(){this.urls=new Set();}
    create(blob){const url=URL.createObjectURL(blob);this.urls.add(url);return url;}
    revoke(url){if(!url||!this.urls.has(url))return;this.urls.delete(url);try{URL.revokeObjectURL(url);}catch(_){}}
    clear(){for(const url of this.urls){try{URL.revokeObjectURL(url);}catch(_){}}this.urls.clear();}
    get size(){return this.urls.size;}
  }
  window.RepositPerformance073={ObjectUrlRegistry};
})();
