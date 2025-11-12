/*
  app.js —— 影调分析工具逻辑脚本
  功能：
    - 拖拽 / 文件选择 / 粘贴 / 系统剪贴板导入图片
    - 计算亮度直方图（分通道可选）
    - 可拖拽阈值线查看暗部 / 中间调 / 高光比例
    - 自适应布局、异步处理进度条
*/

(function(){
    const fileInput = document.getElementById('fileInput');
    const pickBtn = document.getElementById('pickBtn');
    const dropArea = document.getElementById('dropArea');
    const imgCv = document.getElementById('imgCanvas');
    const histCv = document.getElementById('histCanvas');
    const imgCtx = imgCv.getContext('2d');
    const histCtx = histCv.getContext('2d');
    const imgPanelEl = document.querySelector('.imgPanel');

    const infoEl = document.getElementById('imgInfo');
    const meanEl = document.getElementById('meanL');
    const medianEl = document.getElementById('medianL');
    const judgeEl = document.getElementById('toneJudge');
    const shadowPctEl = document.getElementById('shadowPct');
    const midPctEl = document.getElementById('midPct');
    const highlightPctEl = document.getElementById('highlightPct');
    const peakCountEl = document.getElementById('peakCount');
    const paletteEl = document.getElementById('dominantPalette');

    const hTipL = document.getElementById('hTipL');
    const hTipR = document.getElementById('hTipR');

    const rgbMode = document.getElementById('rgbMode');
    const showZones = document.getElementById('showZones');
    const clipWarn = document.getElementById('clipWarn');

    const busy = document.getElementById('busy');
    const busyTitle = document.getElementById('busyTitle');
    const busyBar = document.getElementById('busyBar');
    const busyNote = document.getElementById('busyNote');
    const busyPct = document.getElementById('busyPct');

    function showBusy(title="Processing image…", note="Reading pixels…"){
        busyTitle.textContent = title; busyNote.textContent = note; busyPct.textContent = '0%'; busyBar.style.width = '0%';
        busy.style.display = 'flex';
    }
    function setBusyProgress(p, note){
        const pct = Math.round(p*100); busyBar.style.width = pct + '%'; busyPct.textContent = pct + '%'; if(note) busyNote.textContent = note;
    }
    function hideBusy(){ busy.style.display = 'none'; }

    let imgBitmap = null; let naturalW = 0, naturalH = 0;
    let hist = new Array(256).fill(0);
    let histR = new Array(256).fill(0), histG = new Array(256).fill(0), histB = new Array(256).fill(0);
    let totalPx = 0;
    let dominantColors = [];
    let tShadow = 64; let tHighlight = 192; let dragging = null;

    function clamp(v,min,max){return Math.min(max,Math.max(min,v));}
    function fmtPct(v){return (v*100).toFixed(1)+'%'}

    function resizeCanvasToDisplaySize(canvas, ctx, aspect){
        const cssW = Math.max(100, Math.floor(canvas.clientWidth));
        const cssH = Math.max(80, Math.floor(cssW * aspect));
        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr,0,0,dpr,0,0);
        canvas.style.height = cssH + 'px';
        return {cssW, cssH};
    }

    const bucketSize = 16;
    const bucketBits = Math.max(1, Math.floor(Math.log2(bucketSize))); // bucketSize must stay a power of two
    const bucketCount = bucketSize * bucketSize * bucketSize;
    const quantCounts = new Uint32Array(bucketCount);
    const quantSumR = new Float64Array(bucketCount);
    const quantSumG = new Float64Array(bucketCount);
    const quantSumB = new Float64Array(bucketCount);

    function quantIndex(r, g, b){
        const rBucket = r >> bucketBits;
        const gBucket = g >> bucketBits;
        const bBucket = b >> bucketBits;
        return (rBucket << (bucketBits * 2)) | (gBucket << bucketBits) | bBucket;
    }

    function computeDominantColors(){
        const buckets = [];
        for(let i=0;i<bucketCount;i++){
            const count = quantCounts[i];
            if(!count) continue;
            buckets.push({
                count,
                sumR: quantSumR[i],
                sumG: quantSumG[i],
                sumB: quantSumB[i]
            });
        }
        buckets.sort((a,b)=>b.count-a.count);
        const merged = [];
        const limit = Math.min(buckets.length, 512);
        const threshold = 36;
        const thresholdSq = threshold * threshold;
        for(let i=0;i<limit;i++){
            const bucket = buckets[i];
            const avgR = bucket.sumR / bucket.count;
            const avgG = bucket.sumG / bucket.count;
            const avgB = bucket.sumB / bucket.count;
            let target = null;
            for(const candidate of merged){
                const dr = avgR - candidate.avgR;
                const dg = avgG - candidate.avgG;
                const db = avgB - candidate.avgB;
                if((dr*dr + dg*dg + db*db) <= thresholdSq){
                    target = candidate;
                    break;
                }
            }
            if(target){
                target.count += bucket.count;
                target.sumR += bucket.sumR;
                target.sumG += bucket.sumG;
                target.sumB += bucket.sumB;
                target.avgR = target.sumR / target.count;
                target.avgG = target.sumG / target.count;
                target.avgB = target.sumB / target.count;
            } else {
                merged.push({
                    count: bucket.count,
                    sumR: bucket.sumR,
                    sumG: bucket.sumG,
                    sumB: bucket.sumB,
                    avgR,
                    avgG,
                    avgB
                });
            }
            if(merged.length >= 8 && i > 64) break;
        }
        return merged
            .sort((a,b)=>b.count-a.count)
            .slice(0,6)
            .map(entry=>({
                count: entry.count,
                r: Math.round(entry.avgR),
                g: Math.round(entry.avgG),
                b: Math.round(entry.avgB)
            }));
    }

    async function computeHistogramAsync(img){
        const maxSide = 1400; let w = img.width, h = img.height;
        const scale = Math.min(1, maxSide / Math.max(w,h));
        let off, octx;
        if (typeof OffscreenCanvas !== 'undefined'){
            off = new OffscreenCanvas(Math.max(1, Math.floor(w*scale)), Math.max(1, Math.floor(h*scale)));
            octx = off.getContext('2d', {willReadFrequently:true});
        } else {
            const tmp = document.createElement('canvas');
            tmp.width = Math.max(1, Math.floor(w*scale));
            tmp.height = Math.max(1, Math.floor(h*scale));
            off = tmp;
            octx = tmp.getContext('2d');
        }
        octx.drawImage(img, 0, 0, off.width, off.height);
        const {data} = octx.getImageData(0,0,off.width,off.height);
        hist.fill(0); histR.fill(0); histG.fill(0); histB.fill(0);
        quantCounts.fill(0); quantSumR.fill(0); quantSumG.fill(0); quantSumB.fill(0);
        totalPx = off.width * off.height;
        const total = data.length; const chunk = 400000; let i = 0;
        while(i < total){
            const end = Math.min(i + chunk, total);
            for(let j=i;j<end;j+=4){
                const r=data[j]|0, g=data[j+1]|0, b=data[j+2]|0;
                const y = (0.2126*r + 0.7152*g + 0.0722*b) | 0;
                hist[y]++; histR[r]++; histG[g]++; histB[b]++;
                const idx = quantIndex(r,g,b);
                quantCounts[idx]++;
                quantSumR[idx] += r;
                quantSumG[idx] += g;
                quantSumB[idx] += b;
            }
            setBusyProgress(end/total, 'Computing histogram…');
            await new Promise(r=>setTimeout(r,0));
            i = end;
        }
        dominantColors = computeDominantColors();
    }

    function drawImageFit(){
        const cw=imgCv.clientWidth||0,ch=imgCv.clientHeight||0; imgCtx.clearRect(0,0,cw,ch);
        if(!imgBitmap) return;
        const scale = Math.min(cw / naturalW, ch / naturalH);
        const dw = Math.round(naturalW * scale), dh = Math.round(naturalH * scale);
        const dx = Math.round((cw-dw)/2), dy = Math.round((ch-dh)/2);
        imgCtx.fillStyle = '#0b1220'; imgCtx.fillRect(0,0,cw,ch);
        imgCtx.drawImage(imgBitmap, dx, dy, dw, dh);
    }

    function analyzeAndRender(){
        let sum=0, peak=0, peakBin=0; let cumsum=0; let median=0;
        for(let i=0;i<256;i++){const v=hist[i]; sum += v*i; if(v>peak){peak=v; peakBin=i}}
        const half = totalPx/2; for(let i=0;i<256;i++){cumsum+=hist[i]; if(cumsum>=half){median=i;break;}}
        const mean = sum / (totalPx||1);
        meanEl.textContent = mean.toFixed(1) + ' / 255';
        medianEl.textContent = median + ' / 255';
        peakCountEl.textContent = `${peak} @ ${peakBin}`;
        const sCount = hist.slice(0, tShadow+1).reduce((a,b)=>a+b,0);
        const mCount = hist.slice(tShadow+1, tHighlight+1).reduce((a,b)=>a+b,0);
        const hCount = hist.slice(tHighlight+1).reduce((a,b)=>a+b,0);
        const sPct = sCount/(totalPx||1), mPct = mCount/(totalPx||1), hPct = hCount/(totalPx||1);
        shadowPctEl.textContent = fmtPct(sPct);
        midPctEl.textContent = fmtPct(mPct);
        highlightPctEl.textContent = fmtPct(hPct);
        let tag=''; let cls='tone-mid';
        if(hPct>0.35 && mean>150){tag='高调倾向'; cls='tone-high'}
        else if(sPct>0.35 && mean<105){tag='低调倾向'; cls='tone-low'}
        else {tag='中性/广域对比'; cls='tone-mid'}
        judgeEl.innerHTML = `<span class="toneTag ${cls}">${tag}</span>`;
        drawHistogram(); drawImageFit(); updateHandleTips(); renderPalette();
    }

    function drawHistogram(){
        const W = histCv.clientWidth, H = histCv.clientHeight;
        histCtx.clearRect(0,0,W,H);
        histCtx.fillStyle = '#0b1220';
        histCtx.fillRect(0,0,W,H);
        histCtx.strokeStyle = '#1f2638';
        histCtx.lineWidth = 1;
        for(let i=0;i<=8;i++){const y=Math.round((H-24) * i/8)+12; histCtx.beginPath(); histCtx.moveTo(0,y); histCtx.lineTo(W,y); histCtx.stroke();}
        let maxV = 1; for(let i=0;i<256;i++) maxV = Math.max(maxV, hist[i]);
        const bw = W/256;
        if(rgbMode.checked){
            histCtx.globalAlpha=0.9; histCtx.fillStyle='#ef4444';
            for(let i=0;i<256;i++){const v=histR[i]/maxV; const h=(H-24)*v; histCtx.fillRect(i*bw, H-12-h, Math.max(1,bw-0.5), h);}
            histCtx.globalAlpha=0.7; histCtx.fillStyle='#22c55e';
            for(let i=0;i<256;i++){const v=histG[i]/maxV; const h=(H-24)*v; histCtx.fillRect(i*bw, H-12-h, Math.max(1,bw-0.5), h);}
            histCtx.globalAlpha=0.7; histCtx.fillStyle='#60a5fa';
            for(let i=0;i<256;i++){const v=histB[i]/maxV; const h=(H-24)*v; histCtx.fillRect(i*bw, H-12-h, Math.max(1,bw-0.5), h);}
            histCtx.globalAlpha=1;
        } else {
            const grad = histCtx.createLinearGradient(0,0,0,H);
            grad.addColorStop(0,'#60a5fa');
            grad.addColorStop(1,'#1d4ed8');
            histCtx.fillStyle = grad;
            for(let i=0;i<256;i++){
                const v=hist[i]/maxV; const h=(H-24)*v;
                histCtx.fillRect(i*bw, H-12-h, Math.max(1,bw-0.5), h);
            }
        }
        if(showZones.checked){
            histCtx.globalAlpha=.10;
            histCtx.fillStyle='#94a3b8';
            histCtx.fillRect(0,0,(tShadow+1)*bw,H);
            histCtx.fillStyle='#60a5fa';
            histCtx.fillRect((tShadow+1)*bw,0,(tHighlight-tShadow)*bw,H);
            histCtx.fillStyle='#fca5a5';
            histCtx.fillRect((tHighlight+1)*bw,0,(255-tHighlight)*bw,H);
            histCtx.globalAlpha=1;
        }
        drawHandle(tShadow, '#e5e7eb');
        drawHandle(tHighlight, '#e5e7eb');
    }

    function drawHandle(level, color){
        const W=histCv.clientWidth,H=histCv.clientHeight,bw=W/256;
        const x=level*bw;
        histCtx.save();
        histCtx.strokeStyle=color;
        histCtx.lineWidth=2;
        histCtx.setLineDash([6,4]);
        histCtx.beginPath();
        histCtx.moveTo(Math.round(x)+0.5, 6);
        histCtx.lineTo(Math.round(x)+0.5, H-14);
        histCtx.stroke();
        histCtx.setLineDash([]);
        histCtx.fillStyle=color;
        histCtx.beginPath();
        histCtx.arc(x, 6, 4.5, 0, Math.PI*2);
        histCtx.fill();
        histCtx.restore();
    }

    function updateHandleTips(){
        const W=histCv.clientWidth,bw=W/256;
        hTipL.style.left = (histCv.getBoundingClientRect().left + tShadow*bw) + 'px';
        hTipR.style.left = (histCv.getBoundingClientRect().left + tHighlight*bw) + 'px';
        hTipL.style.display='block';
        hTipR.style.display='block';
        hTipL.textContent = `暗阈 ${tShadow}`;
        hTipR.textContent = `亮阈 ${tHighlight}`;
    }

    pickBtn.addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', (e)=>{ if(e.target.files && e.target.files[0]) loadFile(e.target.files[0]); });
    ['dragenter','dragover','dragleave','drop'].forEach(ev=>{ imgCv.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); }); });
    imgCv.addEventListener('dragenter', ()=> imgPanelEl.classList.add('drag'));
    imgCv.addEventListener('dragover',  ()=> imgPanelEl.classList.add('drag'));
    ['dragleave','drop'].forEach(ev=>{ imgCv.addEventListener(ev, ()=> imgPanelEl.classList.remove('drag')); });
    imgCv.addEventListener('drop', (e)=>{ const f = e.dataTransfer?.files?.[0]; if(f) loadFile(f); });

    async function loadFile(file){
        const url = URL.createObjectURL(file);
        try{
            showBusy('Loading image…','Decoding file…');
            try{ imgBitmap = await createImageBitmap(file); }
            catch{
                imgBitmap = await new Promise((res,rej)=>{
                    const im=new Image();
                    im.onload=()=>res(im); im.onerror=rej;
                    im.src=URL.createObjectURL(file);
                });
            }
            naturalW = imgBitmap.width; naturalH = imgBitmap.height;
            infoEl.textContent = `${file.name || 'Clipboard Image'} · ${naturalW}×${naturalH}`;
            await computeHistogramAsync(imgBitmap);
            analyzeAndRender();
            hideBusy();
        }catch(err){
            console.error(err);
            infoEl.textContent = '加载失败';
            hideBusy();
        }finally{
            URL.revokeObjectURL(url);
        }
    }

    function levelFromX(clientX){
        const rect = histCv.getBoundingClientRect();
        const x = clamp(clientX - rect.left, 0, rect.width);
        return clamp(Math.round(x * 256 / rect.width), 0, 255);
    }

    histCv.addEventListener('mousedown', (e)=>{
        const L = levelFromX(e.clientX);
        const dL = Math.abs(L - tShadow);
        const dR = Math.abs(L - tHighlight);
        dragging = (dL <= dR) ? 'L' : 'R';
        if(dragging==='L') tShadow = clamp(L, 0, tHighlight-1);
        else tHighlight = clamp(L, tShadow+1, 255);
        analyzeAndRender();
    });
    window.addEventListener('mousemove', (e)=>{
        if(!dragging) return;
        const L = levelFromX(e.clientX);
        if(dragging==='L') tShadow = clamp(L, 0, tHighlight-1);
        else tHighlight = clamp(L, tShadow+1, 255);
        analyzeAndRender();
    });
    window.addEventListener('mouseup', ()=> dragging=null);
    rgbMode.addEventListener('change', analyzeAndRender);
    showZones.addEventListener('change', analyzeAndRender);
    clipWarn.addEventListener('change', analyzeAndRender);

    function renderPalette(){
        if(!paletteEl) return;
        paletteEl.innerHTML = '';
        if(!dominantColors.length || !totalPx){
            const span = document.createElement('span');
            span.textContent = '—';
            span.className = 'paletteEmpty';
            paletteEl.appendChild(span);
            return;
        }
        const fmtHex = (v)=> v.toString(16).padStart(2,'0');
        dominantColors.forEach(color=>{
            const {r,g,b,count} = color;
            const hex = `#${fmtHex(r)}${fmtHex(g)}${fmtHex(b)}`.toUpperCase();
            const pct = ((count / totalPx) * 100).toFixed(1);
            const item = document.createElement('div');
            item.className = 'paletteItem';
            const swatch = document.createElement('div');
            swatch.className = 'paletteSwatch';
            swatch.style.background = `rgb(${r},${g},${b})`;
            const label = document.createElement('div');
            label.className = 'paletteLabel';
            label.innerHTML = `<span>${hex}</span><span>${pct}%</span>`;
            item.appendChild(swatch);
            item.appendChild(label);
            paletteEl.appendChild(item);
        });
    }

    function relayout(){
        const imgAspect = parseFloat(imgCv.dataset.aspect)||0.65;
        const histAspect = parseFloat(histCv.dataset.aspect)||0.325;
        resizeCanvasToDisplaySize(imgCv, imgCtx, imgAspect);
        resizeCanvasToDisplaySize(histCv, histCtx, histAspect);
        analyzeAndRender();
    }

    const ro = new ResizeObserver(relayout);
    ro.observe(document.body);
    window.addEventListener('orientationchange', relayout);
    window.addEventListener('resize', relayout);
    relayout();

    // === Paste image from clipboard ===
    window.addEventListener('paste', async (e) => {
        try {
            if (!e.clipboardData) return;
            const items = e.clipboardData.items;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const blob = item.getAsFile();
                    if (blob) {
                        showBusy('Loading from clipboard…', 'Reading clipboard image…');
                        await loadFile(blob);
                        hideBusy();
                        return;
                    }
                }
            }
        } catch (err) {
            console.error('Clipboard paste failed:', err);
        }
    });

    // === Button-triggered clipboard read API ===
    window.readFromClipboard = async function() {
        try {
            showBusy('Clipboard access…');
            const items = await navigator.clipboard.read();
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type);
                        await loadFile(blob);
                        hideBusy();
                        return;
                    }
                }
            }
            hideBusy();
            alert('剪贴板中没有检测到图片');
        } catch (err) {
            console.error(err);
            hideBusy();
            alert('无法访问剪贴板，请检查浏览器权限');
        }
    };

})();
