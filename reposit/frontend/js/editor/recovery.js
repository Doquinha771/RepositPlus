(function(){
  function normalizeDraft(raw,id){if(!raw||typeof raw!=='object')return null;const payload=raw.payload||{};return {note_id:Number(raw.note_id||id||0),title:String(raw.title??payload.title??''),content:String(raw.content??payload.content??''),payload,revision:Math.max(0,Number(raw.revision??raw.saveRevision??0)),timestamp:Number(raw.timestamp??raw.updatedAt??0)};}
  function isNewer(draft,note){return !!draft&&draft.note_id===Number(note?.id)&&draft.revision>Math.max(0,Number(note?.edit_revision||0));}
  function plainPreview(value=''){return String(value).replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]/g,' [bloco] ').replace(/\s+/g,' ').trim();}
  window.RepositEditor072=window.RepositEditor072||{};
  window.RepositEditor072.recovery={normalizeDraft,isNewer,plainPreview};
})();
