'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminDashboard() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', name: '', unit: '', role: 'user' });
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const savedUser = localStorage.getItem('vt_user');
    if (!savedUser) { router.push('/'); return; }
    const user = JSON.parse(savedUser);
    if (user.role !== 'admin') { alert('Bạn không có quyền truy cập!'); router.push('/'); return; }
    fetchUsers();
  }, [router]);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (res.ok) setUsers(data.users);
      else setError(data.error);
    } catch { setError('Lỗi kết nối máy chủ'); }
    finally { setLoading(false); }
  };

  const handleToggle = async (userId, currentStatus) => {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, isActive: !currentStatus }),
      });
      const data = await res.json();
      if (res.ok) setUsers(users.map(u => u.id === userId ? { ...u, isActive: !currentStatus } : u));
      else alert(data.error);
    } catch { alert('Lỗi cập nhật'); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password || !form.name) {
      alert('Vui lòng điền đầy đủ Tài khoản, Mật khẩu và Họ tên');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        setForm({ username: '', password: '', name: '', unit: '', role: 'user' });
        setShowForm(false);
        fetchUsers();
      } else {
        alert(data.error);
      }
    } catch { alert('Lỗi tạo tài khoản'); }
    finally { setCreating(false); }
  };

  if (loading) return (
    <div style={{ color: 'white', textAlign: 'center', padding: 50, minHeight: '100vh', background: 'var(--bg)' }}>
      ⏳ Đang tải...
    </div>
  );

  return (
    <div className="app" style={{ minHeight: '100vh' }}>
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />

      <div style={{ maxWidth: 600, margin: '0 auto', padding: '20px 16px' }}>

        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => router.push('/')} style={{
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
              padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text)',
            }}>← Quay lại</button>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>🛡️ Quản lý tài khoản</h1>
          </div>
          <button onClick={() => setShowForm(!showForm)} style={{
            background: showForm ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)',
            color: showForm ? '#ef4444' : '#10b981',
            border: `1px solid ${showForm ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}`,
            borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 700,
          }}>
            {showForm ? '✕ Đóng' : '➕ Thêm tài khoản'}
          </button>
        </div>

        {error && <div style={{ color: '#ff4d4f', marginBottom: 16, fontSize: 13 }}>{error}</div>}

        {/* FORM TẠO TÀI KHOẢN */}
        {showForm && (
          <form onSubmit={handleCreate} style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>➕ Tạo tài khoản mới</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                placeholder="Tài khoản *" value={form.username}
                onChange={e => setForm({ ...form, username: e.target.value })}
                style={inputStyle}
              />
              <input
                placeholder="Mật khẩu *" value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                style={inputStyle}
              />
            </div>

            <input
              placeholder="Họ tên *" value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                placeholder="Đơn vị" value={form.unit}
                onChange={e => setForm({ ...form, unit: e.target.value })}
                style={inputStyle}
              />
              <select
                value={form.role}
                onChange={e => setForm({ ...form, role: e.target.value })}
                style={inputStyle}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <button type="submit" disabled={creating} style={{
              background: 'var(--gradient)', color: 'white', border: 'none',
              padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 700,
              cursor: creating ? 'wait' : 'pointer', opacity: creating ? 0.7 : 1,
            }}>
              {creating ? '⏳ Đang tạo...' : '✅ Tạo tài khoản'}
            </button>
          </form>
        )}

        {/* DANH SÁCH USER — CARD LAYOUT (mobile-friendly) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {users.map(u => (
            <div key={u.id} style={{
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
              padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
              opacity: u.isActive ? 1 : 0.6, transition: 'opacity 0.2s',
            }}>
              {/* Avatar */}
              <img src={u.avatar} alt="" style={{ width: 42, height: 42, borderRadius: '50%', flexShrink: 0 }} />

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{u.name}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                    background: u.role === 'admin' ? '#d97706' : '#2563eb', color: 'white',
                  }}>{u.role.toUpperCase()}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                  @{u.username} · {u.unit || '—'}
                </div>
              </div>

              {/* Toggle */}
              <button
                onClick={() => handleToggle(u.id, u.isActive)}
                disabled={u.role === 'admin'}
                style={{
                  background: u.isActive ? '#10b981' : '#ef4444',
                  color: 'white', border: 'none', padding: '6px 14px',
                  borderRadius: 20, fontSize: 11, fontWeight: 700,
                  cursor: u.role === 'admin' ? 'not-allowed' : 'pointer',
                  opacity: u.role === 'admin' ? 0.4 : 1,
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {u.isActive ? '✅ BẬT' : '🚫 TẮT'}
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="footer" style={{ marginTop: 20 }}>
          Tổng: {users.length} tài khoản · {users.filter(u => u.isActive).length} đang hoạt động
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  padding: '9px 12px', fontSize: 13, border: '1px solid var(--border)',
  borderRadius: 8, background: 'rgba(0,0,0,0.02)', color: 'var(--text)',
  outline: 'none',
};