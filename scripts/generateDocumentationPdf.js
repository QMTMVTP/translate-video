const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

const projectRoot = path.join(__dirname, '..');
const outputDir = path.join(projectRoot, 'docs');
const outputPath = path.join(outputDir, 'video-translator-documentation.pdf');

const fontCandidates = [
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
const fontPath = fontCandidates.find((candidate) => fs.existsSync(candidate));

if (!fontPath) throw new Error('Khong tim thay font TrueType co ho tro tieng Viet.');
fs.ensureDirSync(outputDir);

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 58, bottom: 58, left: 54, right: 54 },
  bufferPages: true,
});
doc.pipe(fs.createWriteStream(outputPath));
doc.font(fontPath);

const colors = {
  ink: '#20252B', muted: '#5D6874', blue: '#176B87', dark: '#153946',
  line: '#CBD8DE', white: '#FFFFFF',
};

function pageTitle(title) {
  doc.fillColor(colors.blue).fontSize(18).font(fontPath).text(title, { paragraphGap: 8 });
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(541, doc.y).strokeColor(colors.line).stroke();
  doc.moveDown(0.7);
}

function heading(title, level = 2) {
  doc.fillColor(level === 1 ? colors.dark : colors.blue).fontSize(level === 1 ? 16 : 12).font(fontPath).text(title, { paragraphGap: 5 });
  doc.moveDown(0.25);
}

function paragraph(text, options = {}) {
  doc.fillColor(colors.ink).fontSize(options.size || 9.5).font(fontPath).text(text, {
    align: options.align || 'left', lineGap: 2, paragraphGap: 5,
  });
}

function bullet(text) {
  doc.fillColor(colors.ink).fontSize(9.5).font(fontPath).text(`• ${text}`, {
    indent: 10, hanging: 5, lineGap: 2, paragraphGap: 3,
  });
}

function code(text) {
  doc.fillColor(colors.dark).fontSize(9).font(fontPath).text(text, { indent: 10, lineGap: 2, paragraphGap: 4 });
}

function apiRow(method, route, purpose, response) {
  doc.fillColor(colors.ink).fontSize(8.5).font(fontPath).text(`${method}  ${route}`, { continued: true, width: 155 });
  doc.text(purpose, { continued: true, width: 190 });
  doc.text(response, { width: 135, paragraphGap: 5 });
}

function newPage(title) {
  doc.addPage();
  pageTitle(title);
}

doc.rect(0, 0, doc.page.width, doc.page.height).fill(colors.dark);
doc.fillColor(colors.white).fontSize(30).font(fontPath).text('VideoSub AI', 54, 160);
doc.fillColor('#B9E1EA').fontSize(18).font(fontPath).text('Tai lieu mo ta ung dung', 54, 207);
doc.fillColor(colors.white).fontSize(12).font(fontPath).text('Phien am, dich va chen phu de tieng Viet tu dong', 54, 255);
doc.fillColor('#D4E5E8').fontSize(10).font(fontPath).text('Phien ban tai lieu: 1.0 | Cap nhat theo ma nguon hien tai', 54, 700);

newPage('1. Tong quan');
paragraph('VideoSub AI la ung dung web cho phep nguoi dung nhap URL video hoac tai file video tu may tinh. He thong tai va chuan hoa video, trich xuat audio, phien am bang Groq Whisper, dich noi dung sang tieng Viet, tao phu de VTT/SRT va chen phu de vao file MP4.');
heading('Muc dich');
bullet('Tu dong chuyen loi noi trong video thanh cac doan phu de co moc thoi gian.');
bullet('Dich cac doan phu de sang tieng Viet theo lo trinh xu ly tu dong.');
bullet('Cho phep xem truoc video, sua phu de, tai video MP4 va tai file VTT/SRT.');
heading('Quy trinh xu ly');
code('Nguon video -> Tai/nhan file -> FFmpeg trich audio -> Groq Whisper -> Google Translate -> VTT/SRT -> FFmpeg chen phu de -> Xem va tai xuong');
heading('Trang thai va tien do');
bullet('Job duoc tao voi UUID va luu trong Map trong bo nho cua server.');
bullet('Tien do duoc chia thanh 4 buoc: tai video, phien am, dich thuat va hoan tat.');
bullet('Job hoan thanh se tu dong xoa thu muc tam sau 2 gio.');

newPage('2. Backend va API noi bo');
heading('Khoi tao va cau hinh');
bullet('dotenv: doc PORT va GROQ_API_KEY tu bien moi truong. Gia tri bi mat khong duoc luu trong tai lieu nay.');
bullet('express: tao HTTP server, parse JSON toi da 10 MB va phuc vu thu muc public.');
bullet('cors: cho phep client gui request den server tu cac origin khac nhau.');
bullet('multer: nhan multipart upload, luu file vao temp/uploads, gioi han 500 MB.');
bullet('uuid: tao jobId va ten file upload ngau nhien, tranh trung ten.');
heading('Cac endpoint');
apiRow('POST', '/api/process', 'Nhan URL video va tao job xu ly nen.', '{ jobId }');
apiRow('POST', '/api/upload', 'Nhan file video multipart voi field videoFile.', '{ jobId }');
apiRow('GET', '/api/status/:jobId', 'Tra ve trang thai, tien do, log va ket qua job.', 'JSON job');
apiRow('GET', '/api/video/:jobId', 'Stream video goc co ho tro HTTP Range.', 'video/mp4');
apiRow('GET', '/api/download/:jobId', 'Tai file video da chen phu de.', 'video-vietsub.mp4');
apiRow('POST', '/api/subtitles/:jobId', 'Luu phu de da sua va xuat lai MP4.', '{ success, downloadUrl }');
heading('Function trong server.js');
bullet('makeLogEntry(message): tao log kem gio hien tai theo locale vi-VN.');
bullet('appendJobLog(job, message): them log moi, bo trung lap lien tiep va giu toi da 100 dong.');
bullet('getStepProgress(percent): doi phan tram tong thanh buoc hien tai va phan tram cua buoc.');
bullet('burnSubtitlesToVideo(workDir, subtitleFilename): dung FFmpeg hardsub vao khung hinh; neu loi thi fallback sang soft subtitle trong MP4.');
bullet('runJob(jobId, source, isUpload): dieu phoi toan bo pipeline va cap nhat jobs Map.');

newPage('3. Service xu ly video');
heading('services/videoProcessor.js');
bullet('getYtDlp(onProgress): tim bin/yt-dlp.exe tren Windows hoac dung lenh yt-dlp tren Linux/Render.');
bullet('getPlatformName(url): nhan dien YouTube, TikTok, Facebook, Instagram, Twitter/X hoac video chung.');
bullet('isTikTokUrl(url): kiem tra URL co phai TikTok hay khong.');
bullet('downloadTikTokVideo(url, outputPath, onProgress): goi TikWM API, lay link phat HD va tai video ve dia phuong.');
bullet('isDirectVideoUrl(url): nhan dien URL ket thuc bang mp4, webm, mov, mkv, avi, flv hoac m4v.');
bullet('downloadDirectVideo(url, outputPath, onProgress): tai video truc tiep bang fetch va ghi cac chunk vao file.');
bullet('downloadWithYtDlp(url, outputPath, onProgress): chay yt-dlp, chon video toi da 1080p, ghep audio va video thanh MP4.');
bullet('extractAudio(videoPath, audioPath, onProgress): dung FFmpeg tao audio mono 16 kHz de dua vao Whisper.');
bullet('processUploadedFile(uploadedFilePath, jobId, onProgress): chuan hoa file upload sang video.mp4, sau do trich audio.mp3.');
bullet('processVideo(url, jobId, onProgress): chon nhanh tai truc tiep, TikWM hoac yt-dlp dua tren URL.');
heading('Dinh dang va gioi han');
bullet('URL ho tro: video truc tiep, YouTube, TikTok, Facebook, Instagram va cac nguon yt-dlp ho tro.');
bullet('File upload ho tro cac duoi video thong dung; kich thuoc toi da la 500 MB.');
bullet('yt-dlp su dung --no-playlist de chi xu ly mot video, khong tai ca playlist.');

newPage('4. Phien am va dich thuat');
heading('services/transcriber.js');
bullet('transcribe(audioPath): mo file audio bang fs.createReadStream va goi Groq Audio Transcriptions.');
bullet('Model su dung: whisper-large-v3. Response verbose_json va timestamp_granularities segment giup tao moc start/end.');
bullet('Ket qua duoc chuan hoa ve dang { start, end, text }, loai bo segment rong.');
heading('services/translator.js');
bullet('sleep(ms): tao khoang nghi giua cac request.');
bullet('translateText(text): goi Google Translate endpoint khong chinh thuc, tu dong nhan dien ngon ngu va dich sang vi.');
bullet('translateSegments(segments, onProgress): gom 15 segment moi batch, chen separator de giu ranh gioi, nghi 400 ms giua batch.');
bullet('Neu separator bi thay doi, ham thu cach tach thay the; neu van sai, dich tung segment va fallback ve text goc khi loi.');
heading('API ben ngoai');
bullet('Groq Whisper API: phien am audio. Can GROQ_API_KEY hop le va phu thuoc quota tai khoan.');
bullet('Google Translate GTX endpoint: dich van ban, khong co API key trong code; co the bi rate-limit hoac thay doi hanh vi.');
bullet('TikWM API: lay link tai video TikTok; neu that bai, he thong fallback sang yt-dlp.');

newPage('5. Phu de va frontend');
heading('services/subtitleGenerator.js');
bullet('formatTime(seconds): doi giay thanh HH:MM:SS.mmm; dung cho WebVTT va SRT.');
bullet('generateVTT(segments): tao file WEBVTT, escape ky tu < va > trong text.');
bullet('generateSRT(segments): tao file SRT va doi dau phan giay tu cham sang dau phay.');
heading('public/app.js - function chinh');
bullet('switchTab(tab): chuyen giua nhap URL va tai file.');
bullet('handleFileSelected(file), clearSelectedFile(): kiem tra loai file, gioi han 500 MB va quan ly file da chon.');
bullet('handleTranslateUrl(), handleTranslateUpload(): gui request tao job theo hai cach dau vao.');
bullet('startPolling(jobId), pollStatus(jobId), clearPolling(): theo doi API status moi 1,5 giay va cap nhat giao dien.');
bullet('onJobDone(job), renderSubtitleEditor(): nap video va hien thi danh sach segment co the sua.');
bullet('handleApplySubtitles(): gui segment da sua den /api/subtitles/:jobId de xuat lai MP4.');
bullet('cuesToVTT(), cuesToSRT(), parseVTT(), parseVTTTime(), formatVTTTime(): chuyen doi va doc phu de o client.');
bullet('togglePlay(), updateTime(), seek(), formatTime(): dieu khien phat/dung, thanh thoi gian va tua video.');
bullet('setLoadingState(), showProgress(), renderProcessLogs(), updateStepIndicators(), showError(), hideError(): cac helper giao dien.');
heading('Tinh nang nguoi dung');
bullet('Xem video voi phu de dong bo, bat/tat CC, am luong, fullscreen va phim tat Space, mui ten, C.');
bullet('Chinh co chu, vi tri, do trong suot nen va mau chu phu de theo thoi gian thuc.');
bullet('Tai video MP4 da chen phu de hoac tai rieng VTT/SRT.');

newPage('6. Thu vien, cau hinh va van hanh');
heading('Thu vien npm');
bullet('express 4.19: web server va routing.');
bullet('cors 2.8: CORS middleware.');
bullet('dotenv 16.4: bien moi truong.');
bullet('fs-extra 11.2: thao tac file va tao/xoa thu muc async.');
bullet('multer 2.2: upload multipart va gioi han file.');
bullet('ffmpeg-static 5.2: binary FFmpeg kem theo ung dung.');
bullet('groq-sdk 0.7: client goi Groq Whisper.');
bullet('yt-dlp-wrap 2.3: dependency lien quan yt-dlp; pipeline hien tai chay binary qua child_process.');
bullet('uuid 9: sinh UUID.');
bullet('pdfkit 0.19: sinh tai lieu PDF nay.');
bullet('nodemon 3.1: tu khoi dong server khi dev.');
heading('Lenh chay');
code('npm install\nnpm start\nnpm run dev\nnpm run docs:pdf');
heading('Gioi han hien tai');
bullet('Khong co bo dem so video/ngay, tong so phut/ngay, hang doi job hay gioi han concurrency trong code.');
bullet('Moi file upload toi da 500 MB; thoi luong video khong duoc kiem tra truc tiep.');
bullet('jobs Map chi nam trong RAM, mat khi server restart; ket qua tam tu dong xoa sau 2 gio.');
bullet('Hardsub can tai nguyen CPU/RAM; nhieu job dong thoi co the lam cham hoac qua tai may chu.');
heading('Bao mat va de xuat');
bullet('Khong commit file .env vao repository; neu API key da bi lo, can rotate key ngay.');
bullet('Nen bo sung xac thuc nguoi dung, rate limit, queue va gioi han concurrency truoc khi public.');
bullet('Nen kiem tra Range header hop le, gioi han request subtitle va validate noi dung SRT/VTT de giam rui ro.');

newPage('7. Ket luan');
paragraph('Ung dung co pipeline ro rang tu video den phu de tieng Viet. Backend phu trach tai video, FFmpeg, phien am, dich, tao phu de va xuat MP4; frontend phu trach nhap lieu, theo doi tien do, phat video, sua phu de va tai ket qua.');
paragraph('Tai lieu nay duoc tao tu ma nguon hien tai cua project video-translator. Khi thay doi API, model, tham so FFmpeg, gioi han upload hoac function, hay chay lai npm run docs:pdf de cap nhat ban PDF.');

const range = doc.bufferedPageRange();
for (let index = range.start; index < range.start + range.count; index++) {
  doc.switchToPage(index);
  doc.fillColor(colors.muted).fontSize(8).font(fontPath).text(`VideoSub AI | Trang ${index + 1}/${range.count}`, 54, 790, { align: 'right', width: 487 });
}

doc.end();
console.log(`Da tao PDF: ${outputPath}`);