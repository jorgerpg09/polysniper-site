// PolySniper — Fetch stats.json and render live performance data

const STATS_URL = 'stats.json';

async function loadStats() {
    try {
        const resp = await fetch(STATS_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const stats = await resp.json();
        renderStats(stats);
        renderSignals(stats.recent_signals || []);
    } catch (err) {
        console.warn('Failed to load stats:', err);
        document.getElementById('stats-updated').textContent = 'Stats unavailable — check back soon';
    }
}

function renderStats(stats) {
    document.getElementById('stat-bets').textContent = stats.total_bets || 0;
    document.getElementById('stat-wr').textContent = (stats.win_rate || 0) + '%';

    const pnl = stats.pnl || 0;
    const pnlEl = document.getElementById('stat-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? 'var(--win)' : 'var(--loss)';

    const streak = stats.current_streak || 0;
    const streakType = stats.streak_type || '';
    document.getElementById('stat-streak').textContent = streak + streakType;

    // Update timestamp
    if (stats.updated_at) {
        const d = new Date(stats.updated_at);
        document.getElementById('stats-updated').textContent =
            'Updated: ' + d.toLocaleString();
    }
}

function renderSignals(signals) {
    const tbody = document.getElementById('signals-body');
    if (!signals.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No signals yet — bot is warming up</td></tr>';
        return;
    }

    tbody.innerHTML = signals.map(s => {
        const time = new Date(s.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const arrow = s.direction === 'UP' ? '\u2B06' : '\u2B07';
        const resultClass = s.outcome === 'WIN' ? 'result-win' : (s.outcome === 'LOSS' ? 'result-loss' : 'result-pending');
        const resultText = s.outcome || 'PENDING';

        const coinCell = s.slug
            ? `<a href="https://polymarket.com/event/${s.slug}" target="_blank" rel="noopener">${s.coin}</a>`
            : s.coin;

        return `<tr>
            <td>${time}</td>
            <td>${coinCell}</td>
            <td>${arrow} ${s.direction}</td>
            <td>$${(s.entry_price || 0).toFixed(2)}</td>
            <td class="${resultClass}">${resultText}</td>
        </tr>`;
    }).join('');
}

// Load on page load, refresh every 60 seconds
loadStats();
setInterval(loadStats, 60000);
