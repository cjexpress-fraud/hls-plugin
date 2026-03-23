# HLS Plugin (mpv + ffmpeg)

Windows helper plugin สำหรับเล่น/ดาวน์โหลดวิดีโอ CCTV ผ่านโปรโตคอล custom:

- `hls://open?...`  -> เปิดสตรีมด้วย `mpv`
- `hls://download?...` -> ดาวน์โหลด/บันทึกเป็นไฟล์ `.mp4` ด้วย `ffmpeg`

## Contents

- `hls-plugin.pyw`  : ตัวจัดการโปรโตคอล (`hls://...`)
- `mpv.exe`         : ตัวเล่นวิดีโอ
- `ffmpeg.exe`      : ตัวแปลง/ดาวน์โหลดเป็น MP4
- `input.conf`     : key bindings ของ `mpv` (เช่น ปรับ speed)
- `hls-plugin.iss` : Inno Setup script สำหรับ build installer

## Install / Build Installer

ไฟล์ติดตั้งถูกสร้างด้วย `hls-plugin.iss` (Inno Setup).

โฟลเดอร์ `ffmpeg/` ควรมี `ffmpeg.exe` อยู่จริง และ `plugin/` ควรมี `mpv.exe`, `input.conf`, `hls-plugin.pyw`

## URL Protocol

โปรโตคอลที่ลงทะเบียนจะเป็น `hls://...`.

### 1) เปิดเล่น VDO (mpv)

รูปแบบ:

`hls://open?u=<rtsp-url>&title=<window-title>&geometry=1280x720`

ตัวอย่าง:

`hls://open?u=rtsp%3A%2F%2F192.168.1.10%3A554%2Fch1&title=Branch%20%2B%20Camera`

ผลลัพธ์:
- เปิดหน้าต่าง `mpv`
- ใช้ `rtsp_transport=tcp`
- ไม่มี audio (`--no-audio`)
- บังคับให้ OSC แสดง (`--osc=yes` และ `--script-opts=osc-visibility=always`)

### 2) ดาวน์โหลดเป็น MP4 (ffmpeg)

รูปแบบ:

`hls://download?u=<rtsp-url>&title=<file-title>`

ตัวอย่าง:

`hls://download?u=rtsp%3A%2F%2F192.168.1.10%3A554%2Fch1&title=Branch%20%2B%20Camera`

ขั้นตอนที่ plugin ทำ:
- ตรวจสอบ `ffmpeg.exe` ก่อน
- แสดงหน้าต่างเลือกปลายทางไฟล์ (`Save As`) เป็น `.mp4`
- รัน `ffmpeg` เพื่อบันทึก:
  - ตั้งค่า `-rtsp_transport tcp`
  - ใช้ `-c copy` (พยายาม copy codec ตรง ๆ)
  - ใส่ `-movflags +faststart` เพื่อให้เปิดไฟล์ได้เร็วขึ้น

หมายเหตุ:
- ระยะเวลาที่ไฟล์จะ “จบ” ขึ้นกับความยาว/สภาพของสตรีม RTSP ที่กล้องส่งมา

## mpv Key Bindings (input.conf)

ไฟล์ `input.conf` จะถูกโหลดโดย `mpv` ตาม working directory

คีย์ที่ผูกไว้:

- `LEFT`  : `add speed -0.1`
- `RIGHT` : `add speed 0.1`
- `DOWN`  : `set speed 1.0`

## Notes for Frontend Integration

ฝั่งเว็บจะเรียก custom protocol เพื่อให้ Windows plugin ทำงาน:
- ปุ่ม “เล่น VDO” -> เรียก `hls://open?...`
- ปุ่ม “ดาวน์โหลด VDO” -> เรียก `hls://download?...`

ในทั้งสองกรณี ให้ส่ง `u` เป็น RTSP URL (encode แล้ว) และส่ง `title` เพื่อใช้เป็นชื่อหน้าต่าง/ไฟล์.

