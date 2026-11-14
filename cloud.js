/* 云端测试版：Supabase 登录、共享患者数据、版本冲突与在线 AI。 */
(() => {
  'use strict';

  const cfg = window.CLOUD_CONFIG || {};
  const CACHE_KEY = 'disease_survey_cloud_test_v1';
  // 邀请/重置邮件回跳时 URL 会带认证参数，必须在创建客户端前读取，否则会被自动清理。
  const linkParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
  const linkType = linkParams.get('type') || '';
  const linkError = linkParams.get('error_description') || linkParams.get('error') || '';
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
      <p class="subtitle">多人在线协作 · 账号由管理员邮件邀请开通</p>
      <div style="text-align:left;max-width:380px;margin:22px auto 0;">
        <label style="display:block;margin-bottom:14px;">邮箱
          <input id="cloudEmail" type="email" autocomplete="username" placeholder="你的工作邮箱"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <label style="display:block;margin-bottom:18px;">密码
          <input id="cloudPassword" type="password" autocomplete="current-password" placeholder="请输入密码"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <button id="cloudLoginBtn" class="role-start-btn" ${configured ? '' : 'disabled'}>登录在线系统</button>
        <div style="margin-top:10px;display:flex;justify-content:space-between;">
          <a id="cloudRegisterBtn" style="font-size:13px;color:#1890ff;cursor:pointer;">注册新账号</a>
          <a id="cloudForgotBtn" style="font-size:13px;color:#1890ff;cursor:pointer;">忘记密码？</a>
        </div>
        <div id="cloudLoginStatus" style="margin-top:14px;line-height:1.6;color:${configured ? '#666' : '#d4380d'};">
          ${esc(message || (configured ? '首次使用请点管理员邀请邮件中的链接设置密码。' : '云端尚未配置：请先填写 config.js 中的 Supabase 公开配置。'))}
        </div>
        <div style="margin-top:16px;font-size:12px;color:#999;line-height:1.6;">
          数据保存在统一云数据库；AI 密钥不会显示在网页中。未经单位许可，请勿录入真实病人资料。
        </div>
      </div>`;
    const btn = document.getElementById('cloudLoginBtn');
    if (configured) {
      btn.addEventListener('click', login);
      document.getElementById('cloudForgotBtn').addEventListener('click', sendResetMail);
      document.getElementById('cloudRegisterBtn').addEventListener('click', renderRegister);
      card.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => {
        if (event.key === 'Enter') login();
      }));
    }
  }

  // 自助注册：填自己的邮箱和密码，注册后需管理员在系统内批准才能看数据。
  function renderRegister(message) {
    cloudReady = false;
    document.getElementById('view-mainApp').classList.remove('active');
    const view = document.getElementById('view-roleSelector');
    view.classList.add('active');
    const card = view.querySelector('.role-card');
    card.innerHTML = `
      <h1>📝 注册新账号</h1>
      <p class="subtitle">使用你自己的邮箱注册，提交后等管理员批准</p>
      <div style="text-align:left;max-width:380px;margin:22px auto 0;">
        <label style="display:block;margin-bottom:14px;">邮箱
          <input id="regEmail" type="email" autocomplete="username" placeholder="例如 xxx@qq.com"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <label style="display:block;margin-bottom:14px;">密码
          <input id="regPwd1" type="password" autocomplete="new-password" placeholder="至少 6 位"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <label style="display:block;margin-bottom:18px;">确认密码
          <input id="regPwd2" type="password" autocomplete="new-password" placeholder="再次输入密码"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <button id="regSubmitBtn" class="role-start-btn">提交注册</button>
        <div style="margin-top:10px;text-align:right;">
          <a id="regBackBtn" style="font-size:13px;color:#1890ff;cursor:pointer;">返回登录</a>
        </div>
        <div id="regStatus" style="margin-top:14px;line-height:1.6;color:${message ? '#d4380d' : '#666'};">
          ${esc(message || '密码由你本人设置，管理员也无法查看。')}
        </div>
      </div>`;
    document.getElementById('regSubmitBtn').addEventListener('click', register);
    document.getElementById('regBackBtn').addEventListener('click', () => renderLogin());
    card.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => {
      if (event.key === 'Enter') register();
    }));
  }

  async function register() {
    const email = document.getElementById('regEmail').value.trim();
    const p1 = document.getElementById('regPwd1').value;
    const p2 = document.getElementById('regPwd2').value;
    const status = document.getElementById('regStatus');
    const btn = document.getElementById('regSubmitBtn');
    status.style.color = '#d4380d';
    if (!email || !email.includes('@')) { status.textContent = '请填写正确的邮箱。'; return; }
    if (p1.length < 6) { status.textContent = '密码至少 6 位。'; return; }
    if (p1 !== p2) { status.textContent = '两次输入的密码不一致。'; return; }
    btn.disabled = true;
    status.style.color = '#1890ff';
    status.textContent = '正在提交注册…';
    try {
      const { data, error } = await cloud.auth.signUp({ email, password: p1 });
      if (error) throw error;
      if (!data.session) {
        status.style.color = '#52c41a';
        status.textContent = '注册成功，但需要邮箱验证。请联系管理员在后台确认你的账号。';
        btn.disabled = false;
        return;
      }
      await cloud.auth.signOut();
      status.style.color = '#52c41a';
      status.textContent = '注册成功！已通知管理员审批，批准后即可用该邮箱和密码登录。';
      setTimeout(() => renderLogin('账号已提交，等待管理员审批。'), 1600);
    } catch (error) {
      status.style.color = '#d4380d';
      const msg = String(error.message || '');
      status.textContent = /already|exists|registered/i.test(msg)
        ? '该邮箱已注册，请直接登录或点“忘记密码”。'
        : '注册失败：' + (msg || '请稍后重试');
      btn.disabled = false;
    }
  }

  // 待审批 / 被停用账号的提示页
  function renderPending(message) {
    cloudReady = false;
    document.getElementById('view-mainApp').classList.remove('active');
    const view = document.getElementById('view-roleSelector');
    view.classList.add('active');
    const card = view.querySelector('.role-card');
    card.innerHTML = `
      <h1>⏳ 账号待审批</h1>
      <p class="subtitle">${esc(message || '管理员批准后即可进入系统')}</p>
      <div style="max-width:380px;margin:22px auto 0;">
        <button id="pendingLogoutBtn" class="role-start-btn">退出登录</button>
        <div style="margin-top:14px;font-size:12px;color:#999;line-height:1.6;">
          审批通过后重新打开本页面即可，无需再次注册。
        </div>
      </div>`;
    document.getElementById('pendingLogoutBtn').addEventListener('click', async () => {
      await cloud.auth.signOut();
      renderLogin();
    });
  }

  // 忘记密码：向登录邮箱发送重置链接（链接回到本页后进入设置新密码流程）。
  async function sendResetMail() {
    const email = (document.getElementById('cloudEmail').value || '').trim();
    const status = document.getElementById('cloudLoginStatus');
    status.style.color = '#d4380d';
    if (!email) { status.textContent = '请先在上面填写邮箱，再点“忘记密码”。'; return; }
    status.style.color = '#1890ff';
    status.textContent = '正在发送重置邮件…';
    const { error } = await cloud.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) {
      status.style.color = '#d4380d';
      const msg = String(error.message || '');
      status.textContent = /rate limit|exceeded/i.test(msg)
        ? '重置邮件发送次数已达上限，请联系管理员在后台重置。'
        : '发送失败：' + msg;
      return;
    }
    status.style.color = '#52c41a';
    status.textContent = '重置邮件已发送，请到邮箱点击链接设置新密码（若未收到请查看垃圾箱）。';
  }

  function clearAuthHash() {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
  }

  // 邀请/重置链接回跳后：设置一次本人密码，之后用邮箱+密码正常登录。
  function renderSetPassword() {
    const isInvite = linkType === 'invite';
    document.getElementById('view-mainApp').classList.remove('active');
    const view = document.getElementById('view-roleSelector');
    view.classList.add('active');
    const card = view.querySelector('.role-card');
    card.innerHTML = `
      <h1>${isInvite ? '🔑 设置登录密码' : '🔑 重置登录密码'}</h1>
      <p class="subtitle">${isInvite ? '账号已开通，请设置你自己的密码' : '请设置新的登录密码'}</p>
      <div style="text-align:left;max-width:380px;margin:22px auto 0;">
        <label style="display:block;margin-bottom:14px;">新密码
          <input id="setPwd1" type="password" autocomplete="new-password" placeholder="至少 6 位"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <label style="display:block;margin-bottom:18px;">确认密码
          <input id="setPwd2" type="password" autocomplete="new-password" placeholder="再次输入新密码"
            style="width:100%;box-sizing:border-box;padding:11px;margin-top:6px;border:1px solid #d9d9d9;border-radius:6px;">
        </label>
        <button id="setPwdBtn" class="role-start-btn">保存并进入系统</button>
        <div id="setPwdStatus" style="margin-top:14px;line-height:1.6;color:#666;">
          密码由你本人设置并加密保存，管理员也无法查看。
        </div>
      </div>`;
    document.getElementById('setPwdBtn').addEventListener('click', submitNewPassword);
    card.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => {
      if (event.key === 'Enter') submitNewPassword();
    }));
  }

  async function submitNewPassword() {
    const p1 = document.getElementById('setPwd1').value;
    const p2 = document.getElementById('setPwd2').value;
    const status = document.getElementById('setPwdStatus');
    const btn = document.getElementById('setPwdBtn');
    status.style.color = '#d4380d';
    if (p1.length < 6) { status.textContent = '密码至少 6 位。'; return; }
    if (p1 !== p2) { status.textContent = '两次输入的密码不一致。'; return; }
    btn.disabled = true;
    status.style.color = '#1890ff';
    status.textContent = '正在保存密码…';
    try {
      const { data: { session } } = await cloud.auth.getSession();
      if (!session) throw new Error('链接已失效，请联系管理员重新发送邀请');
      const { error } = await cloud.auth.updateUser({ password: p1 });
      if (error) throw error;
      clearAuthHash();
      status.style.color = '#52c41a';
      status.textContent = '密码已保存，正在进入系统…';
      await enterCloud(session);
    } catch (error) {
      status.style.color = '#d4380d';
      status.textContent = '保存失败：' + (error.message || '请重新打开邮件链接');
      btn.disabled = false;
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
      .select('*').eq('id', session.user.id).single();
    if (error || !profile) { renderPending('账号资料缺失，请联系管理员'); return; }
    // status 字段由审批脚本新增；未升级时按 active 处理，避免把老账号锁在门外。
    if (profile.status && profile.status !== 'active') {
      renderPending(profile.status === 'blocked'
        ? '账号已被停用，请联系管理员'
        : '账号已注册，等待管理员批准后即可进入系统');
      return;
    }

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
    document.getElementById('memberBtn').style.display = actualRole === 'admin' ? '' : 'none';
    document.getElementById('pwdBtn').style.display = '';
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

  window.openPwdModal = () => {
    document.getElementById('newPwd1').value = '';
    document.getElementById('newPwd2').value = '';
    const status = document.getElementById('pwdStatus');
    status.style.color = '#666';
    status.textContent = '修改后请用新密码登录，旧密码立即失效。';
    document.getElementById('pwdSaveBtn').disabled = false;
    document.getElementById('pwdModal').classList.add('active');
  };

  window.closePwdModal = () => {
    document.getElementById('pwdModal').classList.remove('active');
  };

  window.changePassword = async () => {
    const p1 = document.getElementById('newPwd1').value;
    const p2 = document.getElementById('newPwd2').value;
    const status = document.getElementById('pwdStatus');
    const btn = document.getElementById('pwdSaveBtn');
    status.style.color = '#d4380d';
    if (p1.length < 6) { status.textContent = '密码至少 6 位。'; return; }
    if (p1 !== p2) { status.textContent = '两次输入的密码不一致。'; return; }
    btn.disabled = true;
    status.style.color = '#1890ff';
    status.textContent = '正在保存…';
    const { error } = await cloud.auth.updateUser({ password: p1 });
    if (error) {
      status.style.color = '#d4380d';
      status.textContent = '保存失败：' + error.message;
      btn.disabled = false;
      return;
    }
    status.style.color = '#52c41a';
    status.textContent = '密码已更新，下次登录请使用新密码。';
    setTimeout(() => window.closePwdModal(), 1200);
  };

  // 成员审批：管理员批准注册申请、停用账号、调整管理员权限。
  async function refreshMembers() {
    const body = document.getElementById('memberBody');
    const { data, error } = await cloud.from('profiles')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { body.textContent = '读取失败：' + error.message; return; }
    const rows = data || [];
    const pending = rows.filter(r => r.status === 'pending').length;
    const head = `<div style="padding:8px 4px 12px;color:#666;">共 ${rows.length} 个账号，待审批 <b style="color:#d4380d;">${pending}</b> 个</div>`;
    const table = '<table class="patient-table"><thead><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      rows.map(r => {
        const s = r.status || 'active';
        const st = s === 'active' ? '✅ 正常' : (s === 'blocked' ? '⛔ 已停用' : '⏳ 待审批');
        const btn = (label, action, arg) => `<button class="btn btn-default" style="padding:4px 10px;margin:2px;" onclick="memberAction('${r.id}','${action}'${arg ? `,'${arg}'` : ''})">${label}</button>`;
        const acts = [];
        if (s === 'pending') acts.push(btn('批准', 'status', 'active'));
        if (s === 'active') acts.push(btn('停用', 'status', 'blocked'));
        if (s === 'blocked') acts.push(btn('恢复', 'status', 'active'));
        acts.push(r.role === 'admin' ? btn('取消管理员', 'role', 'investigator') : btn('设为管理员', 'role', 'admin'));
        return `<tr><td>${esc(r.email || '—')}</td><td>${esc(r.display_name)}</td><td>${r.role === 'admin' ? '👑 管理员' : '👨‍⚕️ 调查员'}</td><td>${st}</td><td style="white-space:nowrap;">${acts.join('')}</td></tr>`;
      }).join('') + '</tbody></table>';
    body.innerHTML = head + table;
  }

  window.openMemberModal = async () => {
    if (actualRole !== 'admin') { alert('仅管理员可以审批成员'); return; }
    document.getElementById('memberModal').classList.add('active');
    document.getElementById('memberBody').innerHTML = '<div style="padding:16px;color:#999;">加载中…</div>';
    await refreshMembers();
  };

  window.closeMemberModal = () => {
    document.getElementById('memberModal').classList.remove('active');
  };

  window.memberAction = async (id, field, value) => {
    if (actualRole !== 'admin') return;
    if (id === cloudUserId && field === 'role' && value !== 'admin') {
      alert('不能取消自己的管理员权限。');
      return;
    }
    const { error } = await cloud.from('profiles').update({ [field]: value }).eq('id', id);
    if (error) { alert('操作失败：' + error.message); return; }
    await refreshMembers();
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
    // 与 Supabase 中已部署的 Edge Function 名称一致（控制台里显示的函数名）
    const response = await fetch(cfg.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/bright-function', {
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
      if (linkError) {
        clearAuthHash();
        renderLogin('账号开通链接已失效（' + linkError + '），请联系管理员重新发送邀请。');
        return;
      }
      if (linkType === 'invite' || linkType === 'recovery') {
        renderSetPassword();
        return;
      }
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
