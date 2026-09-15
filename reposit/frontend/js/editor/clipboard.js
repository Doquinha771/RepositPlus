(function(){
  function imageFromClipboard(event){
    const items=[...(event.clipboardData?.items||[])];const item=items.find(x=>x.kind==='file'&&String(x.type||'').startsWith('image/'));if(!item)return null;
    const blob=item.getAsFile();if(!blob)return null;const ext=(blob.type.split('/')[1]||'png').replace('jpeg','jpg');return new File([blob],`Captura-${new Date().toISOString().replace(/[:.]/g,'-')}.${ext}`,{type:blob.type,lastModified:Date.now()});
  }
  window.RepositEditor072=window.RepositEditor072||{};
  window.RepositEditor072.clipboard={imageFromClipboard};
})();
