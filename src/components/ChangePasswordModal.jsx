'use client';
import { useState } from 'react';

export default function ChangePasswordModal({ user, onClose }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Client-side validation
    if (!oldPassword || !newPassword || !confirmPassword) {
      setError('Vui lòng điền đầy đủ các trường.');
      return;
    }
    if (newPassword.length < 3) {
      setError('Mật khẩu mới phải có ít nhất 3 ký tự.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu mới không khớp.');
      return;
    }
    if (newPassword === oldPassword) {
      setError('Mật khẩu mới không được trùng với mật khẩu cũ.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          oldPassword,
          newPassword,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Đổi mật khẩu thất bại.');
        return;
      }

      setSuccess('✅ Đổi mật khẩu thành công!');
      setTimeout(() => onClose(), 1500);
    } catch {
      setError('Lỗi kết nối máy chủ.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', margin: 0 }}>🔑 Đổi mật khẩu</h2>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 10, border: '1px solid var(--border)' }}>
          <img src={user.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{user.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>@{user.username}</div>
          </div>
        </div>

        {/* Messages */}
        {error && <div style={errorStyle}>⚠️ {error}</div>}
        {success && <div style={successStyle}>{success}</div>}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={labelStyle}>Mật khẩu hiện tại</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="Nhập mật khẩu hiện tại"
              style={inputStyle}
              autoFocus
            />
          </div>
          <div>
            <label style={labelStyle}>Mật khẩu mới</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Tối thiểu 3 ký tự"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Nhập lại mật khẩu mới</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Xác nhận mật khẩu mới"
              style={inputStyle}
            />
          </div>
          <button type="submit" disabled={loading} style={{
            ...submitBtnStyle,
            opacity: loading ? 0.7 : 1,
            cursor: loading ? 'wait' : 'pointer',
          }}>
            {loading ? '⏳ Đang xử lý...' : '✅ Xác nhận đổi mật khẩu'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Styles ───
const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
};

const modalStyle = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: 16, padding: '20px 22px', width: '100%', maxWidth: 400,
  boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
};

const closeBtnStyle = {
  background: 'none', border: 'none', color: 'var(--text2)',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px', borderRadius: 8,
};

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--text2)', marginBottom: 4,
};

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 10,
  background: 'rgba(0,0,0,0.02)', color: 'var(--text)',
  outline: 'none', boxSizing: 'border-box',
};

const submitBtnStyle = {
  marginTop: 6, padding: '11px 0', fontSize: 14, fontWeight: 700,
  background: 'var(--gradient)', color: 'white', border: 'none',
  borderRadius: 10,
};

const errorStyle = {
  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
  color: '#ef4444', padding: '8px 12px', borderRadius: 10,
  fontSize: 13, marginBottom: 6,
};

const successStyle = {
  background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
  color: '#10b981', padding: '8px 12px', borderRadius: 10,
  fontSize: 13, fontWeight: 600, marginBottom: 6,
};
