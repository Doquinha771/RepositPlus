(function(){
  function cellFromSelection(){const sel=window.getSelection(),node=sel?.anchorNode;const el=node?.nodeType===1?node:node?.parentElement;return el?.closest?.('td,th')||null;}
  function blankCell(tag='td'){const el=document.createElement(tag);el.innerHTML='<br>';return el;}
  function operate(action,cell=cellFromSelection()){
    if(!cell)return false;const row=cell.parentElement,table=cell.closest('table');if(!row||!table)return false;
    const idx=[...row.children].indexOf(cell);
    if(action==='row-above'||action==='row-below'){const tr=document.createElement('tr');for(let i=0;i<row.children.length;i++)tr.appendChild(blankCell(row.children[i].tagName.toLowerCase()));action==='row-above'?row.before(tr):row.after(tr);}
    if(action==='row-remove'&&table.rows.length>1)row.remove();
    if(action==='col-before'||action==='col-after'){[...table.rows].forEach(r=>{const tag=r.parentElement?.tagName==='THEAD'?'th':'td';const target=action==='col-before'?r.children[idx]:r.children[idx+1];r.insertBefore(blankCell(tag),target||null);});}
    if(action==='col-remove'&&row.children.length>1)[...table.rows].forEach(r=>r.children[idx]?.remove());
    if(action==='header-toggle'){
      const first=table.rows[0];if(!first)return false;const makeHeader=first.children[0]?.tagName!=='TH';[...first.children].forEach(old=>{const repl=blankCell(makeHeader?'th':'td');repl.innerHTML=old.innerHTML;for(const a of old.attributes)repl.setAttribute(a.name,a.value);old.replaceWith(repl);});
    }
    return true;
  }
  function handleTab(event){
    if(event.key!=='Tab'||event.ctrlKey||event.altKey)return false;
    const cell=cellFromSelection();if(!cell)return false;const table=cell.closest('table'),cells=[...table.querySelectorAll('td,th')],idx=cells.indexOf(cell);let next=cells[idx+(event.shiftKey?-1:1)];
    if(!next&&!event.shiftKey){const row=table.rows[table.rows.length-1],tr=document.createElement('tr');for(let i=0;i<row.cells.length;i++)tr.appendChild(blankCell(row.cells[i].tagName.toLowerCase()));table.tBodies[0]?.appendChild(tr)||table.appendChild(tr);next=tr.cells[0];}
    if(next){event.preventDefault();const range=document.createRange(),sel=window.getSelection();range.selectNodeContents(next);range.collapse(true);sel.removeAllRanges();sel.addRange(range);next.scrollIntoView({block:'nearest',inline:'nearest'});return true;}
    return false;
  }
  function setColumnWidth(cell,width){if(!cell)return false;const table=cell.closest('table'),idx=[...cell.parentElement.children].indexOf(cell),value=Math.max(60,Math.min(600,Number(width)||140));[...table.rows].forEach(r=>{if(r.children[idx])r.children[idx].style.width=`${value}px`;});return true;}
  window.RepositEditor072=window.RepositEditor072||{};
  window.RepositEditor072.tables={cellFromSelection,operate,handleTab,setColumnWidth};
})();
