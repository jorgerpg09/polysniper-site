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

    const kellyPnl = stats.kelly_pnl || 0;
    const kellyEl = document.getElementById('stat-kelly-pnl');
    if (kellyEl) {
        kellyEl.textContent = (kellyPnl >= 0 ? '+' : '') + '$' + kellyPnl.toFixed(2);
        kellyEl.style.color = kellyPnl >= 0 ? 'var(--win)' : 'var(--loss)';
    }
    // Color the PnL card border based on overall
    const pnlCard = pnlEl && pnlEl.closest('.stat-card');
    if (pnlCard) {
        const overall = pnl + kellyPnl;
        pnlCard.style.borderColor = overall >= 0 ? 'var(--win)' : 'var(--loss)';
    }

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

// ==========================================================================
// PolyWeather -- Phase 4 stats (D-13)
// ==========================================================================

const PW_STATS_URL = 'polyweather-stats.json';
let pwChart = null;

async function loadPolyWeather() {
    try {
        const resp = await fetch(PW_STATS_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const stats = await resp.json();
        renderPolyWeatherStats(stats);
        renderPolyWeatherChart(stats.daily_pnl || []);
        renderPolyWeatherTrades(stats.recent_trades || []);
    } catch (err) {
        console.warn('Failed to load polyweather stats:', err);
        const el = document.getElementById('pw-updated');
        if (el) el.textContent = 'Stats unavailable -- check back soon';
    }
}

function renderPolyWeatherStats(stats) {
    const hitRate = (stats.hit_rate || 0) * 100;
    document.getElementById('pw-hit-rate').textContent = hitRate.toFixed(1) + '%';

    const pnl = stats.theoretical_pnl || 0;
    const pnlEl = document.getElementById('pw-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? 'var(--win)' : 'var(--loss)';

    document.getElementById('pw-trades').textContent = stats.trade_count || 0;
    document.getElementById('pw-cities').textContent = stats.active_cities || 0;

    if (stats.updated_at) {
        const d = new Date(stats.updated_at);
        document.getElementById('pw-updated').textContent =
            'Updated: ' + d.toLocaleString();
    }
}

function renderPolyWeatherChart(dailyPnl) {
    const canvas = document.getElementById('pw-pnl-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const labels = dailyPnl.map(d => d.date);
    const data = dailyPnl.map(d => d.cumulative_pnl);
    const cfg = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Cumulative P&L (USDC)',
                data: data,
                borderColor: '#22c55e',
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                fill: true,
                tension: 0.25,
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { labels: { color: '#e5e7eb' } } },
            scales: {
                x: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } },
                y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
            }
        }
    };
    if (pwChart) { pwChart.destroy(); }
    pwChart = new Chart(canvas, cfg);
}

function renderPolyWeatherTrades(trades) {
    const tbody = document.getElementById('pw-trades-body');
    if (!tbody) return;
    if (!trades.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No paper trades yet -- bot is warming up</td></tr>';
        return;
    }
    tbody.innerHTML = trades.map(t => {
        const time = new Date(t.logged_at).toLocaleString([], {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        const outcome = (t.outcome || 'PENDING').toUpperCase();
        const cls = outcome === 'WIN'  ? 'result-win'
                  : outcome === 'LOSS' ? 'result-loss'
                  : 'result-pending';
        const edgePct = ((t.edge || 0) * 100).toFixed(1) + '%';
        const size = '$' + (t.kelly_size_usdc || 0).toFixed(2);
        return `<tr>
            <td>${time}</td>
            <td>${t.city}</td>
            <td><code>${t.bracket}</code></td>
            <td>${edgePct}</td>
            <td>${size}</td>
            <td class="${cls}">${outcome}</td>
        </tr>`;
    }).join('');
}

// Extend the existing cadence: load on init and refresh every 60s alongside PolySniper.
loadPolyWeather();
setInterval(loadPolyWeather, 60000);
