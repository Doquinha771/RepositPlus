(function(){
  const BLOCK_SELECTOR='[data-file-token],[data-subnote-token]';
  function directBlock(node, editor){
    if(!node)return null;
    const el=node.nodeType===1?node:node.parentElement;
    const block=el?.closest?.(BLOCK_SELECTOR);
    return block&&editor?.contains(block)?block:null;
  }
  function adjacentBlock(range,key,editor){
    if(!range||!range.collapsed)return null;
    let candidate=null;
    const node=range.startContainer;
    if(node.nodeType===1){
      candidate=key==='Backspace'?node.childNodes[range.startOffset-1]:node.childNodes[range.startOffset];
    }else if(node.nodeType===3){
      if(key==='Backspace'&&range.startOffset===0)candidate=node.previousSibling;
      if(key==='Delete'&&range.startOffset===node.textContent.length)candidate=node.nextSibling;
    }
    if(!candidate)return null;
    return directBlock(candidate,editor) || (candidate.nodeType===1&&candidate.matches?.(BLOCK_SELECTOR)?candidate:null);
  }
  function placeCaret(block,after=true){
    if(!block?.isConnected)return false;
    const sel=window.getSelection(),range=document.createRange();
    if(after)range.setStartAfter(block);else range.setStartBefore(block);
    range.collapse(true);sel.removeAllRanges();sel.addRange(range);
    block.closest('[contenteditable="true"]')?.focus({preventScroll:true});
    return true;
  }
  function rangeFromPoint(editor,x,y){
    let range=null;
    if(document.caretRangeFromPoint)range=document.caretRangeFromPoint(x,y);
    else if(document.caretPositionFromPoint){const pos=document.caretPositionFromPoint(x,y);if(pos){range=document.createRange();range.setStart(pos.offsetNode,pos.offset);range.collapse(true);}}
    if(!range||!editor.contains(range.startContainer))return null;
    const block=directBlock(range.startContainer,editor);
    if(block){const rect=block.getBoundingClientRect();const after=y>rect.top+rect.height/2;range=document.createRange();after?range.setStartAfter(block):range.setStartBefore(block);range.collapse(true);}
    return range;
  }
  function insertIndicator(editor,range){
    editor.querySelector('.inline-drop-indicator')?.remove();
    if(!range)return null;
    const marker=document.createElement('div');marker.className='inline-drop-indicator';marker.contentEditable='false';marker.textContent='inserir aqui';
    const r=range.cloneRange();r.collapse(true);r.insertNode(marker);return marker;
  }
  function clearIndicator(editor){editor?.querySelector('.inline-drop-indicator')?.remove();}
  window.RepositEditor072=window.RepositEditor072||{};
  window.RepositEditor072.inlineBlocks={BLOCK_SELECTOR,directBlock,adjacentBlock,placeCaret,rangeFromPoint,insertIndicator,clearIndicator};
})();
