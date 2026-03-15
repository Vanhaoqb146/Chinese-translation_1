'use client';
import { useState } from 'react';
import './login.css';

export default function LoginForm({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Đăng nhập thất bại');
      }

      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-content">
        <div className="login-card">
          <div className="login-header">
            <div className="login-icon-wrap"><span className="login-icon">🔐</span></div>
            <h1 className="login-title">Đăng Nhập</h1>
            <p className="login-subtitle">Truy cập hệ thống VoiceTranslate AI</p>
          </div>
          {error && <div className="login-error"><span>⚠️</span> {error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Tài khoản</label>
              <div className="input-wrapper">
                <span className="input-icon">👤</span>
                <input type="text" className="login-input" placeholder="Nhập tên đăng nhập" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </div>
            </div>
            <div className="form-group">
              <label>Mật khẩu</label>
              <div className="input-wrapper">
                <span className="input-icon">🔑</span>
                <input type="password" className="login-input" placeholder="Nhập mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </div>
            <button type="submit" className="login-btn" disabled={isLoading}>
              {isLoading ? <><span className="spinner"></span> Đang xử lý...</> : 'Đăng Nhập'}
            </button>
          </form>
          <div className="login-footer">
            <p></p>
          </div>
        </div>
      </div>
    </div>
  );
}
