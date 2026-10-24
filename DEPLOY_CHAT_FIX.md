# 📦 Checklist Deploy Chat Fix lên cPanel

## ✅ File cần upload

### 1. Backend
```
server.cjs                       ← File gốc (đã có sẵn)
controllers/chatController.js    ← Đã sửa fallback aggregate
controllers/chatSseController.js ← SSE real-time
routes/chatRoutes.js             ← Route mới
services/shopee/chat.js          ← Broadcast SSE
```

### 2. Frontend
```
dist/                            ← Toàn bộ thư mục (đè lên cũ)
```

---

## 🚀 Các bước deploy

### Bước 1: Upload file backend
1. Vào **File Manager** trên cPanel
2. Upload **ĐÈ** các file backend vào thư mục gốc:
   - `server.cjs`
   - `controllers/chatController.js`
   - `controllers/chatSseController.js`
   - `routes/chatRoutes.js`
   - `services/shopee/chat.js`

### Bước 2: Upload frontend
1. **XÓA thư mục `dist/` cũ** trên cPanel
2. Upload **toàn bộ thư mục `dist/`** mới (kéo thả folder)
3. Đợi upload xong (kiểm tra file `dist/index.html` có ngày giờ mới nhất)

### Bước 3: Restart server
1. Vào **Setup Node.js App**
2. Chọn ứng dụng
3. Click **Restart**
4. Đợi trạng thái chuyển sang **Running**

### Bước 4: Xóa cache trình duyệt
1. Mở trang web
2. Nhấn `Ctrl + Shift + Delete`
3. Chọn **"Cached images and files"**
4. Xóa cache **1 giờ gần nhất**
5. Reload lại trang: `Ctrl + Shift + R`

### Bước 5: Kiểm tra
1. Vào tab **"Trả lời tin nhắn khách"**
2. Kiểm tra:
   - ✅ Không còn lỗi "Cannot access 'Y' before initialization"
   - ✅ Hiển thị số tin nhắn chưa đọc ở badge
   - ✅ Danh sách hội thoại load được
   - ✅ Tin nhắn mới hiện popup góc phải dưới

---

## ⚠️ Lưu ý

- **KHÔNG copy từng file** trong `dist/` → Phải copy **toàn bộ thư mục**
- Hash file JS thay đổi mỗi lần build → `index.html` tham chiếu hash mới
- Nếu copy sai file JS cũ → Lỗi TDZ vẫn còn
- Nếu không xóa cache → Trình duyệt vẫn dùng code cũ

---

## 🐛 Nếu vẫn lỗi

1. Mở **DevTools** (F12)
2. Tab **Console** → Chụp lỗi đầy đủ
3. Tab **Network** → Kiểm tra file JS nào được load
4. Gửi screenshot để debug tiếp
