'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const FLAG_MAP = {
  zh: '🇨🇳', vi: '🇻🇳', en: '🇺🇸', ja: '🇯🇵', ko: '🇰🇷',
};

export default function HistoryPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('vt_user');
    if (!saved) {
      router.push('/');
      return;
    }
    const u = JSON.parse(saved);
    setUser(u);

    fetch(`/api/history?userId=${encodeURIComponent(u.username)}`)
      .then(r => r.json())
      .then(data => {
        if (data.history) setHistory(data.history);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [router]);

  // Nhóm lịch sử theo ngày
  const groupedByDay = {};
  history.forEach(item => {
    const d = new Date(item.createdAt);
    const key = d.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });
    if (!groupedByDay[key]) groupedByDay[key] = [];
    groupedByDay[key].push(item);
  });

  const days = Object.keys(groupedByDay);

  // Tự mở ngày mới nhất
  useEffect(() => {
    if (days.length > 0 && expandedDay === null) {
      setExpandedDay(days[0]);
    }
  }, [days.length]);

  const handleDelete = async (id) => {
    if (!confirm('Xóa bản ghi này?')) return;
    try {
      const res = await fetch(`/api/history?id=${id}`, { method: 'DELETE' });
      if (res.ok) setHistory(prev => prev.filter(h => h.id !== id));
    } catch (e) { console.error(e); }
  };

  const handleDeleteAll = async () => {
    if (!confirm('Xóa TOÀN BỘ lịch sử hội thoại?')) return;
    try {
      const res = await fetch(`/api/history?userId=${encodeURIComponent(user.username)}`, { method: 'DELETE' });
      if (res.ok) setHistory([]);
    } catch (e) { console.error(e); }
  };

  const flag = (lang) => FLAG_MAP[lang] || '🌐';

  return (
    <div className="app">
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />
      <div className="bg-orb bg-orb-3" />
      <div className="container" style={{ maxWidth: 700 }}>

        {/* HEADER */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 20, flexWrap: 'wrap', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => router.push('/')}
              style={{
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '8px 16px', cursor: 'pointer',
                fontSize: 14, fontWeight: 600, color: 'var(--text)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              ← Quay lại
            </button>
            <h1 style={{
              fontSize: 20, fontWeight: 700,
              background: 'var(--gradient)', WebkitBackgroundClip: 'text',
              backgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              📋 Lịch sử giao tiếp
            </h1>
          </div>

          {history.length > 0 && (
            <button
              onClick={handleDeleteAll}
              style={{
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, color: '#ef4444',
              }}
            >
              🗑️ Xóa tất cả
            </button>
          )}
        </div>

        {/* STATS */}
        <div style={{
          display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap',
        }}>
          <div style={{
            flex: 1, minWidth: 120, background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '10px 14px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent1)' }}>{history.length}</div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>Tổng câu dịch</div>
          </div>
          <div style={{
            flex: 1, minWidth: 120, background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '10px 14px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent2)' }}>{days.length}</div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>Số ngày giao tiếp</div>
          </div>
        </div>

        {/* LOADING */}
        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>
            ⏳ Đang tải lịch sử...
          </div>
        )}

        {/* EMPTY */}
        {!loading && history.length === 0 && (
          <div style={{
            textAlign: 'center', padding: 60, color: 'var(--muted)',
            background: 'var(--card)', borderRadius: 16, border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>💬</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Chưa có lịch sử</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Bắt đầu giao tiếp để lưu lịch sử tại đây</div>
          </div>
        )}

        {/* HISTORY BY DAY */}
        {days.map(day => (
          <div key={day} style={{
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 12, marginBottom: 12, overflow: 'hidden',
          }}>
            {/* Day header — bấm để mở/đóng */}
            <button
              onClick={() => setExpandedDay(expandedDay === day ? null : day)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', background: 'rgba(0,0,0,0.02)', border: 'none',
                cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--text)',
                borderBottom: expandedDay === day ? '1px solid var(--border)' : 'none',
              }}
            >
              <span>📅 {day}</span>
              <span style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12, color: 'var(--text2)',
              }}>
                <span style={{
                  background: 'var(--accent1)', color: 'white',
                  borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 700,
                }}>
                  {groupedByDay[day].length} câu
                </span>
                <span style={{ fontSize: 16, transition: 'transform 0.2s', transform: expandedDay === day ? 'rotate(180deg)' : '' }}>▼</span>
              </span>
            </button>

            {/* Messages */}
            {expandedDay === day && (
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {groupedByDay[day].map(item => (
                  <div key={item.id} style={{
                    display: 'flex', flexDirection: 'column', gap: 2,
                    animation: 'fadeIn 0.2s ease',
                  }}>
                    {/* Câu gốc */}
                    <div style={{
                      background: 'white', color: '#1f2937',
                      padding: '10px 14px', borderRadius: '12px 12px 4px 4px',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                      borderLeft: '3px solid #0ea5e9',
                      fontSize: 15, lineHeight: 1.5,
                    }}>
                      <span style={{ fontSize: 13, marginRight: 6 }}>{flag(item.fromLang)}</span>
                      {item.source}
                    </div>

                    {/* Bản dịch */}
                    <div style={{
                      background: 'linear-gradient(135deg, #0ea5e9, #06b6d4)',
                      color: 'white', padding: '10px 14px',
                      borderRadius: '4px 4px 12px 12px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                      fontSize: 15, lineHeight: 1.5,
                    }}>
                      <span style={{ fontSize: 13, marginRight: 6 }}>{flag(item.toLang)}</span>
                      {item.target}
                    </div>

                    {/* Time + delete */}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0 6px', marginTop: 2,
                    }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>🕐 {item.time}</span>
                      <button
                        onClick={() => handleDelete(item.id)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontSize: 12, color: 'var(--muted)', opacity: 0.6,
                        }}
                        title="Xóa"
                      >✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Footer */}
        <div className="footer" style={{ marginTop: 16 }}>
          Ứng dụng dịch thuật thông minh
        </div>
      </div>
    </div>
  );
}
