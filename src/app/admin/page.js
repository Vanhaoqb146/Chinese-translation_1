'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminDashboard() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const router = useRouter();

    useEffect(() => {
        // 1. Kiểm tra quyền Admin
        const savedUser = localStorage.getItem('vt_user');
        if (!savedUser) {
            router.push('/');
            return;
        }
        const user = JSON.parse(savedUser);
        if (user.role !== 'admin') {
            alert('Bạn không có quyền truy cập trang này!');
            router.push('/');
            return;
        }

        // 2. Tải danh sách người dùng
        fetchUsers();
    }, [router]);

    const fetchUsers = async () => {
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            if (res.ok) {
                setUsers(data.users);
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError('Lỗi kết nối máy chủ');
        } finally {
            setLoading(false);
        }
    };

    const handleToggleStatus = async (userId, currentStatus) => {
        try {
            const res = await fetch('/api/admin/users', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, isActive: !currentStatus }),
            });
            const data = await res.json();

            if (res.ok) {
                // Cập nhật lại UI lập tức
                setUsers(users.map(u => u.id === userId ? { ...u, isActive: !currentStatus } : u));
            } else {
                alert(data.error); // Thông báo nếu cố gắng khóa Admin gốc
            }
        } catch (err) {
            alert('Lỗi cập nhật trạng thái');
        }
    };

    if (loading) return <div style={{ color: 'white', textAlign: 'center', padding: '50px' }}>Đang tải dữ liệu...</div>;

    return (
        <div className="app" style={{ padding: '40px 20px', minHeight: '100vh' }}>
            <div className="bg-orb bg-orb-1" />
            <div className="bg-orb bg-orb-2" />

            <div style={{ maxWidth: '1000px', margin: '0 auto', background: 'rgba(0,0,0,0.6)', padding: '30px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)', color: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
                    <h2>🛡️ Dashboard Quản trị</h2>
                    <button onClick={() => router.push('/')} style={{ background: 'rgba(255,255,255,0.1)', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer' }}>
                        ⬅ Về Trang chủ
                    </button>
                </div>

                {error && <div style={{ color: '#ff4d4f', marginBottom: '20px' }}>{error}</div>}

                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)', color: '#aaa' }}>
                            <th style={{ padding: '15px 10px' }}>Người dùng</th>
                            <th style={{ padding: '15px 10px' }}>Tài khoản</th>
                            <th style={{ padding: '15px 10px' }}>Đơn vị</th>
                            <th style={{ padding: '15px 10px' }}>Vai trò</th>
                            <th style={{ padding: '15px 10px', textAlign: 'center' }}>Truy cập</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(u => (
                            <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                <td style={{ padding: '15px 10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <img src={u.avatar} alt="avatar" style={{ width: '36px', height: '36px', borderRadius: '50%' }} />
                                    <strong>{u.name}</strong>
                                </td>
                                <td style={{ padding: '15px 10px' }}>{u.username}</td>
                                <td style={{ padding: '15px 10px' }}>{u.unit}</td>
                                <td style={{ padding: '15px 10px' }}>
                                    <span style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '12px', background: u.role === 'admin' ? '#d97706' : '#2563eb' }}>
                                        {u.role.toUpperCase()}
                                    </span>
                                </td>
                                <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                                    <button
                                        onClick={() => handleToggleStatus(u.id, u.isActive)}
                                        style={{
                                            background: u.isActive ? '#10b981' : '#ef4444',
                                            color: 'white',
                                            border: 'none',
                                            padding: '8px 16px',
                                            borderRadius: '20px',
                                            cursor: u.role === 'admin' ? 'not-allowed' : 'pointer',
                                            opacity: u.role === 'admin' ? 0.5 : 1,
                                            fontWeight: 'bold',
                                            transition: '0.3s'
                                        }}
                                        disabled={u.role === 'admin'}
                                    >
                                        {u.isActive ? 'ĐANG BẬT' : 'ĐÃ TẮT'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}