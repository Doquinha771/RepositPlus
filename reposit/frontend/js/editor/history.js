(function(){
  class SpecialHistory{
    constructor(limit=128){
      const maxBytes=arguments.length>1?arguments[1]:16*1024*1024;
      this.limit=Math.max(100,Number(limit)||128);
      this.maxBytes=Math.max(2*1024*1024,Number(maxBytes)||16*1024*1024);
      this.undoStack=[];this.redoStack=[];this.bytes=0;
    }
    _cost(item){return 2*((item?.before?.length||0)+(item?.after?.length||0));}
    _trim(){
      while(this.undoStack.length>this.limit){const item=this.undoStack.shift();this.bytes=Math.max(0,this.bytes-this._cost(item));}
      while(this.bytes>this.maxBytes&&this.undoStack.length>1){const item=this.undoStack.shift();this.bytes=Math.max(0,this.bytes-this._cost(item));}
    }
    record(before,after,label='operation'){
      if(before===after)return;
      const item={before,after,label};this.undoStack.push(item);this.bytes+=this._cost(item);
      this.redoStack.length=0;this._trim();
    }
    undo(current){const item=this.undoStack[this.undoStack.length-1];if(!item||item.after!==current)return null;this.undoStack.pop();this.bytes=Math.max(0,this.bytes-this._cost(item));this.redoStack.push(item);return item.before;}
    redo(current){const item=this.redoStack[this.redoStack.length-1];if(!item||item.before!==current)return null;this.redoStack.pop();this.undoStack.push(item);this.bytes+=this._cost(item);this._trim();return item.after;}
    clear(){this.undoStack.length=0;this.redoStack.length=0;this.bytes=0;}
  }
  window.RepositEditor072=window.RepositEditor072||{};
  window.RepositEditor072.SpecialHistory=SpecialHistory;
})();
