/* 云端测试版：Supabase 登录、共享患者数据、版本冲突与在线 AI。 */
(() => {
  'use strict';

  const cfg = window.CLOUD_CONFIG || {};
  const CACHE_KEY = 'disease_survey_cloud_test_v1';
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  const cloud = configured
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  let actualRole = null;
  let cloudUserId = null;
  let snapshots = new Map();
  let conflicts = new Map();
  let conflictPrompted = new Set();
  let realtimeChannel = null;
  let saveTimer = null;
  let pushing = false;
  let pushAgain = false;
  let cloudReady = false;

  const clone = value => JSON.parse(JSON.stringify(value));
  const json = value => JSON.stringify(value);
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function cachePatients() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(patients)); } catch (e) {}
  }

  function setCloudStatus(ok, text) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.style.display = '';
    el.textContent = text || (ok ? '🌐 云端已连接' : '⚠ 云端连接异常');
    el.style.color = ok ? '#52c41a' : '#d4380d';
  }

  function renderLogin(message) {
    cloudReady = false;
    document.getElementById('view-mainApp').classList.remove('active');
    const view = document.getElementById('view-roleSelector');
    view.classList.add('active');
    const card = view.querySelector('.role-card');
    card.innerHTML = `
      <h1>📋 疾病资料调查协作系统</h1>
      <p class="subtitle">免费多人在线测试版 · 仅限虚拟测试数据</p>
      <div style="text-align:left;max-width:380px;margin:22px auto 0;">
        <label style="display:block;margin-bottom:14px;">邮箱
          <input id="cloudEmail" type="email" autocomplete="username" placeholder="管理员分配的邮箱"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <label style="display:block;margin-bottom:18px;">密码
          <input id="cloudPassword" type="password" autocomplete="current-password" placeholder="请输入密码"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <button id="cloudLoginBtn" class="role-start-btn" ${configured ? '' : 'disabled'}>登录在线系统</button>
        <div id="cloudLoginStatus" style="margin-top:14px;line-height:1.6;color:${configured ? '#666' : '#d4380d'};">
          ${esc(message || (configured ? '使用管理员分配的账号登录。' : '云端尚未配置：请先填写 config.js 中的 Supabase 公开配置。'))}
        </div>
        <div style="margin-top:16px;font-size:12px;color:#999;line-height:1.6;">
          数据保存在统一云数据库；AI 密钥不会显示在网页中。未经单位许可，请勿录入真实病人资料。
        </div>
      </div>`;
    const btn = document.getElementById('cloudLoginBtn');
    if (configured) {
      btn.addEventListener('click', login);
      card.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => {
        if (event.key === 'Enter') login();
      }));
    }
  }

  async function login() {
    const email = document.getElementById('cloudEmail').value.trim();
    const password = document.getElementById('cloudPassword').value;
    const status = document.getElementById('cloudLoginStatus');
    const btn = document.getElementById('cloudLoginBtn');
    if (!email || !password) {
      status.textContent = '请输入邮箱和密码。';
      status.style.color = '#d4380d';
      return;
    }
    btn.disabled = true;
    status.style.color = '#1890ff';
    status.textContent = '正在登录并读取云端数据…';
    try {
      const { error } = await cloud.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { data: { session } } = await cloud.auth.getSession();
      await enterCloud(session);
    } catch (error) {
      status.textContent = '登录失败：' + (error.message || '请检查账号、网络及云端配置');
      status.style.color = '#d4380d';
      btn.disabled = false;
    }
  }

  async function enterCloud(session) {
    if (!session) { renderLogin(); return; }
    const { data: profile, error } = await cloud.from('profiles')
      .select('display_name,role').eq('id', session.user.id).single();
    if (error || !profile) throw new Error('账号尚未分配系统角色，请联系管理员');

    cloudUserId = session.user.id;
    actualRole = profile.role;
    currentUser = { name: profile.display_name || session.user.email, role: 'admin' };
    // 应用内部统一走管理员共享编辑分支；真实角色单独控制删除和日志权限。
    currentRole = 'admin';
    SERVER_MODE = true;
    backendChecked = true;
    await loadCloudPatients();
    await enterSystem();

    document.body.classList.toggle('cloud-investigator', actualRole !== 'admin');
    document.getElementById('roleBadge').textContent = actualRole === 'admin' ? '👑 管理员' : '👨‍⚕️ 调查员';
    document.getElementById('userNameDisplay').textContent = currentUser.name;
    document.getElementById('logBtn').style.display = actualRole === 'admin' ? '' : 'none';
    const switchBtn = document.querySelector('button[onclick="switchRole()"]');
    if (switchBtn) {
      switchBtn.style.display = '';
      switchBtn.innerHTML = '退出登录';
    }
    setCloudStatus(true);
    cloudReady = true;
    subscribeRealtime();
  }

  async function loadCloudPatients() {
    const { data, error } = await cloud.from('patients')
      .select('id,study_id,payload,version,updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    patients = (data || []).map(row => ({ ...row.payload, id: row.id, studyId: row.study_id }));
    snapshots = new Map((data || []).map(row => [row.id, {
      version: Number(row.version),
      json: json({ ...row.payload, id: row.id, studyId: row.study_id })
    }]));
    conflicts.clear();
    conflictPrompted.clear();
    cachePatients();
  }

  function rowForPatient(patient) {
    const snap = snapshots.get(patient.id);
    return {
      id: patient.id,
      study_id: patient.studyId,
      payload: patient,
      version: snap ? snap.version : 0
    };
  }

  function isDirty(id) {
    const p = patients.find(item => item.id === id);
    if (!p) return false;
    const snap = snapshots.get(id);
    return !snap || snap.json !== json(p);
  }

  function isEditing(id) {
    return currentPatientId === id && document.getElementById('view-formFill').classList.contains('active');
  }

  function applyRemote(row, force) {
    if (!row) return;
    const id = row.id;
    if (!force && (isDirty(id) || isEditing(id))) {
      conflicts.set(id, row);
      setCloudStatus(false, '⚠ 有远端更新待核对');
      return;
    }
    const incoming = { ...row.payload, id: row.id, studyId: row.study_id };
    const index = patients.findIndex(p => p.id === id);
    if (index >= 0) patients[index] = incoming;
    else patients.unshift(incoming);
    snapshots.set(id, { version: Number(row.version), json: json(incoming) });
    conflicts.delete(id);
    conflictPrompted.delete(id);
    cachePatients();
    refreshOpenViews();
  }

  function removeRemote(id, force) {
    if (!force && (isDirty(id) || isEditing(id))) {
      conflicts.set(id, null);
      setCloudStatus(false, '⚠ 远端记录已删除，待人工核对');
      return;
    }
    patients = patients.filter(p => p.id !== id);
    snapshots.delete(id);
    conflicts.delete(id);
    conflictPrompted.delete(id);
    cachePatients();
    refreshOpenViews();
  }

  function refreshOpenViews() {
    updateStats();
    updateAdminTabCounts();
    if (document.getElementById('view-patientList').classList.contains('active')) renderPatientTable();
    if (document.getElementById('view-patientDetail').classList.contains('active')) renderPatientDetail();
  }

  async function fetchRemote(id) {
    const { data, error } = await cloud.from('patients')
      .select('id,study_id,payload,version,updated_at').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function resolveConflict(id, remoteRow) {
    const remote = remoteRow === undefined ? await fetchRemote(id) : remoteRow;
    conflicts.set(id, remote);
    setCloudStatus(false, '⚠ 保存冲突，需人工核对');
    if (conflictPrompted.has(id)) return;
    conflictPrompted.add(id);
    const discard = confirm('该病人已被其他用户更新或删除。\n\n点击“确定”：放弃本地修改并加载远端版本。\n点击“取消”：保留当前本地内容，稍后可复制后人工合并。');
    if (discard) {
      if (remote) applyRemote(remote, true);
      else removeRemote(id, true);
      if (document.getElementById('view-formFill').classList.contains('active')) {
        showView(remote ? 'patientDetail' : 'patientList');
        if (remote) openPatientDetail(id);
      }
      setCloudStatus(true);
    }
  }

  function changedPatients() {
    return patients.filter(p => {
      const snap = snapshots.get(p.id);
      return (!snap || snap.json !== json(p)) && !conflicts.has(p.id);
    });
  }

  async function pushChanges() {
    if (!cloudReady || !cloud) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    pushAgain = false;
    setCloudStatus(true, '🌐 正在同步…');
    const changed = changedPatients();
    const removed = deletedIds.splice(0);
    let failed = false;

    try {
      for (const p of changed) {
        const expected = snapshots.get(p.id)?.version || 0;
        const { data, error } = await cloud.rpc('save_patient', {
          p_id: p.id,
          p_study_id: String(p.studyId || '').trim(),
          p_payload: p,
          p_expected_version: expected
        });
        if (error) {
          if (error.code === '23505') throw new Error('研究编号「' + p.studyId + '」已存在，请核对后再保存');
          throw error;
        }
        const version = Number(data);
        if (version === -1) {
          await resolveConflict(p.id);
          continue;
        }
        snapshots.set(p.id, { version, json: json(p) });
        conflictPrompted.delete(p.id);
      }

      for (const id of removed) {
        if (conflicts.has(id)) continue;
        const { error } = await cloud.from('patients').delete().eq('id', id);
        if (error) {
          deletedIds.unshift(id);
          throw error;
        }
        snapshots.delete(id);
      }
      cachePatients();
      setCloudStatus(!conflicts.size, conflicts.size ? '⚠ 有记录待人工合并' : '🌐 云端已同步');
    } catch (error) {
      failed = true;
      setCloudStatus(false);
      alert('云端保存失败：' + (error.message || error) + '\n本地内容仍保留，请检查网络后重试。');
    } finally {
      pushing = false;
      if (pushAgain && !failed) setTimeout(pushChanges, 200);
    }
  }

  function subscribeRealtime() {
    if (realtimeChannel) cloud.removeChannel(realtimeChannel);
    realtimeChannel = cloud.channel('shared-patients')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, event => {
        const row = event.new;
        const old = event.old;
        const id = row?.id || old?.id;
        if (!id) return;
        if (row && snapshots.get(id)?.version >= Number(row.version)) return;
        if (event.eventType === 'DELETE') removeRemote(id, false);
        else applyRemote(row, false);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setCloudStatus(!conflicts.size, conflicts.size ? '⚠ 有记录待人工合并' : '🌐 协作已连接');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setCloudStatus(false);
      });
  }

  // 替换单机与旧局域网存储入口。
  window.detectBackend = async () => true;
  window.syncInit = async () => true;
  window.loadData = () => {};
  window.saveData = () => {
    cachePatients();
    updateStats();
    updateAdminTabCounts();
    window.pushState();
  };
  window.pushState = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushChanges, 300);
  };
  window.syncLatestData = async () => {
    if (!cloudReady) return;
    setCloudStatus(true, '🌐 正在获取最新数据…');
    try {
      const { data, error } = await cloud.from('patients')
        .select('id,study_id,payload,version,updated_at');
      if (error) throw error;
      const rows = data || [];
      const remoteIds = new Set(rows.map(row => row.id));
      for (const row of rows) {
        if (conflicts.has(row.id) || isDirty(row.id) || isEditing(row.id)) {
          await resolveConflict(row.id, row);
        } else applyRemote(row, true);
      }
      for (const p of [...patients]) {
        if (!remoteIds.has(p.id)) {
          if (conflicts.has(p.id) || isDirty(p.id) || isEditing(p.id)) await resolveConflict(p.id, null);
          else removeRemote(p.id, true);
        }
      }
      setCloudStatus(!conflicts.size, conflicts.size ? '⚠ 有记录待人工合并' : '🌐 已获取最新数据');
      refreshOpenViews();
    } catch (error) {
      setCloudStatus(false);
      alert('同步失败：' + error.message);
    }
  };

  async function logout() {
    if (changedPatients().length || deletedIds.length) {
      if (!confirm('仍有内容正在同步，确定退出登录吗？')) return;
    }
    await cloud.auth.signOut();
    location.reload();
  }
  window.switchRole = logout;
  window.handleAuthExpired = logout;
  window.showRoleSelector = () => renderLogin();

  const originalDeletePatient = window.deletePatient;
  window.deletePatient = () => {
    if (actualRole !== 'admin') { alert('仅管理员可以删除病人'); return; }
    originalDeletePatient();
  };
  const originalDeleteFollowup = window.deleteFollowup;
  window.deleteFollowup = id => {
    if (actualRole !== 'admin') { alert('仅管理员可以删除随访记录'); return; }
    originalDeleteFollowup(id);
  };

  window.openLogModal = async () => {
    if (actualRole !== 'admin') { alert('仅管理员可以查看操作日志'); return; }
    const modal = document.getElementById('logModal');
    const body = document.getElementById('logBody');
    modal.classList.add('active');
    body.innerHTML = '<div style="padding:16px;color:#999;">加载中…</div>';
    const { data, error } = await cloud.from('audit_log')
      .select('created_at,actor_name,action,patient_id,version')
      .order('created_at', { ascending: false }).limit(200);
    if (error) { body.textContent = '读取失败：' + error.message; return; }
    if (!data?.length) { body.innerHTML = '<div style="padding:16px;color:#999;">暂无操作记录</div>'; return; }
    body.innerHTML = '<table class="patient-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>患者ID</th><th>版本</th></tr></thead><tbody>' +
      data.map(log => `<tr><td>${esc(new Date(log.created_at).toLocaleString())}</td><td>${esc(log.actor_name)}</td><td>${esc(log.action)}</td><td>${esc(log.patient_id)}</td><td>${esc(log.version)}</td></tr>`).join('') +
      '</tbody></table>';
  };

  // 在线 AI：复用原页面提示词、DOCX/图片解析和人工确认，只替换模型请求通道。
  window.getAISettings = () => ({
    mode: 'cloud', endpoint: '', textModel: '', visionModel: '', preset: 'custom',
    baseUrl: 'server', apiKey: 'server-side', cloudTextModel: 'server', cloudVisionModel: 'server'
  });
  window.saveAISettings = () => {};
  window.cloudChat = async (_base, _key, _model, prompt, images) => {
    const { data: { session } } = await cloud.auth.getSession();
    if (!session) throw new Error('登录已失效，请重新登录');
    const response = await fetch(cfg.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/ai-recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ prompt, images: images || [] })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '在线 AI 返回 ' + response.status);
    return result.text || '';
  };
  const originalOpenAI = window.openAIImport;
  window.openAIImport = () => {
    originalOpenAI();
    document.getElementById('aiCloudBox').style.display = 'none';
    document.getElementById('aiOllamaBox').style.display = 'none';
    document.getElementById('aiMode').closest('label').style.display = 'none';
    const conn = document.getElementById('aiConn');
    conn.textContent = '在线多模态 AI：密钥由服务器保管。仅用于虚拟测试资料，结果必须人工核对。';
  };

  async function boot() {
    const style = document.createElement('style');
    style.textContent = 'body.cloud-investigator [onclick="deletePatient()"],body.cloud-investigator [onclick^="deleteFollowup("]{display:none!important;}';
    document.head.appendChild(style);
    if (!configured) { renderLogin(); return; }
    try {
      const { data: { session } } = await cloud.auth.getSession();
      if (session) await enterCloud(session);
      else renderLogin();
    } catch (error) {
      renderLogin('云端初始化失败：' + error.message);
    }
  }

  window.addEventListener('beforeunload', event => {
    if (cloudReady && (changedPatients().length || deletedIds.length)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  boot();
})();
