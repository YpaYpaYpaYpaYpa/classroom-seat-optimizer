import { validateInput, settingsFromClass, resolveGroupColumns } from './input-model.js';

export const SIGNUP_PASSWORD_MIN = 8;
export const CLASS_NAME = '2학년 5반';

export function validateCredentials({ email, password, confirmation }, mode = 'signin') {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return '올바른 이메일 주소를 입력해 주세요.';
  if (!password) return '비밀번호를 입력해 주세요.';
  if (mode === 'signup' && password.length < SIGNUP_PASSWORD_MIN) return '회원가입 비밀번호는 8자 이상이어야 합니다.';
  if (mode === 'signup' && password !== confirmation) return '비밀번호 확인이 일치하지 않습니다.';
  return '';
}

export function accountErrorMessage(error) {
  const code = error?.code;
  const message = error?.message ?? '';
  if (code === 'SESSION_CHANGED') return '계정이 변경되어 요청을 취소했습니다.';
  if (code === 'SIGNED_OUT') return '먼저 로그인해 주세요.';
  if (message.includes('CLASSROOM_LOAD_REQUIRED')) return '이미 저장된 데이터가 있습니다. 먼저 불러오거나 덮어쓰기를 확인해 주세요.';
  if (message.includes('CLASSROOM_VERSION_CONFLICT')) return '다른 창에서 저장 데이터가 변경되었습니다. 최신 데이터를 다시 불러온 뒤 저장해 주세요.';
  if (message.includes('CLASSROOM_INVALID_INPUT')) return '학생·관계·배치 설정을 다시 확인해 주세요. DB에는 변경사항을 반영하지 않았습니다.';
  if (['PGRST202', 'PGRST205', '42P01', '42703', '42883'].includes(code)) return 'DB 초기 설정이 필요합니다. Supabase에서 supabase-schema.sql을 실행해 주세요.';
  if (code === '42501' || message.includes('CLASSROOM_OWNER_MISMATCH')) return '이 계정의 데이터에 접근할 권한이 없습니다. 로그인 상태를 확인해 주세요.';
  if (['PGRST301', 'PGRST303', 'bad_jwt', 'session_not_found', 'refresh_token_not_found'].includes(code)) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (code === 'invalid_credentials') return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (code === 'email_not_confirmed') return '이메일 인증 후 로그인해 주세요. 인증 메일을 다시 보낼 수 있습니다.';
  if (code === 'user_already_exists') return '이미 등록된 계정입니다. 로그인해 주세요.';
  if (code === 'weak_password') return '더 안전한 비밀번호를 사용해 주세요. 서버의 비밀번호 정책도 충족해야 합니다.';
  if (['email_address_invalid', 'validation_failed'].includes(code)) return '이메일과 비밀번호 형식을 확인해 주세요.';
  if (code === 'signup_disabled') return '현재 서버에서 회원가입이 비활성화되어 있습니다.';
  if (code === 'email_address_not_authorized') return '현재 Supabase 메일 발송 설정에서 이 이메일로 인증 메일을 보낼 수 없습니다. 관리자 SMTP 설정이 필요합니다.';
  if (code === 'over_email_send_rate_limit' || /email rate limit exceeded/i.test(message)) return '인증 메일 발송 한도에 도달했습니다. 이미 받은 인증 메일과 스팸함을 확인해 주세요. 메일이 없다면 한도 회복을 기다리거나 관리자에게 SMTP 설정을 요청해 주세요.';
  if (code?.includes('rate_limit') || error?.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'captcha_failed') return '서버의 CAPTCHA 설정을 확인해야 합니다.';
  if (code === 'REQUEST_TIMEOUT' || /fetch|network|abort|timeout|ENOTFOUND/i.test(message)) return '서버에 연결하지 못했습니다. Supabase 프로젝트 상태와 인터넷 연결을 확인해 주세요. 저장 중이었다면 불러오기로 저장 여부를 확인해 주세요.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function snapshotPayload(input, result = null) {
  const issues = validateInput(input);
  if (issues.length) throw Object.assign(new Error(issues[0].message), { code: 'INVALID_INPUT' });
  const payload = {
    students: input.students.map((student, order) => ({ id: student.id, score: student.score, vision: Boolean(student.vision), order })),
    relations: input.relations.map(({ first, second, type }) => ({ first, second, type })),
    settings: {
      groupCount: input.settings.groupCount,
      groupColumns: resolveGroupColumns(input.settings.groupCount, input.settings.groupColumns),
      scoreMode: input.settings.scoreMode, friendMode: input.settings.friendMode,
      respectVision: Boolean(input.settings.respectVision), avoidPrevious: Boolean(input.settings.avoidPrevious),
    },
  };
  if (result) {
    payload.arrangement = {
      metrics: result.metrics,
      layout: { groupColumns: result.layout.groupColumns, seatColumns: result.layout.seatColumns, blockRows: result.layout.blockRows },
      assignments: result.seated.map(student => ({
        studentNumber: student.id, groupNumber: student.groupNumber,
        seatIndex: student.row * result.layout.groupColumns * result.layout.seatColumns + student.column + 1,
      })),
    };
  }
  return payload;
}

export function classroomSnapshot(data, userId) {
  if (!data) return null;
  if (data.classroom?.owner_id !== userId) throw Object.assign(new Error('CLASSROOM_OWNER_MISMATCH'), { code: '42501' });
  const students = data.students ?? [];
  const byId = new Map(students.map(student => [student.id, student.student_number]));
  return {
    classroom: data.classroom,
    students: students.map(student => ({ id: student.student_number, score: student.score, vision: student.vision_priority, order: student.sort_order })),
    relations: (data.relations ?? []).map(relation => ({ first: byId.get(relation.first_student_id), second: byId.get(relation.second_student_id), type: relation.relation_type })),
    settings: settingsFromClass(data.classroom),
  };
}

// The owner is sent explicitly AND checked against auth.uid() in the database.
// This prevents an old A-account request from saving into a newly signed-in B account.
export function createAccountStore(client, { timeoutMs = 12000 } = {}) {
  let user = null, epoch = 0, writing = false;
  const pending = new Set();
  function setUser(nextUser) {
    if (user?.id !== nextUser?.id) {
      epoch++;
      for (const controller of pending) controller.abort();
    }
    user = nextUser ?? null;
  }
  async function request(name, args, ownerRequired = true) {
    if (ownerRequired && !user) throw Object.assign(new Error('로그인 필요'), { code: 'SIGNED_OUT' });
    const owner = user?.id, revision = epoch;
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { data, error } = await client.rpc(name, ownerRequired ? { ...args, p_owner_id: owner } : args).abortSignal(controller.signal);
      if (revision !== epoch) throw Object.assign(new Error('계정 변경'), { code: 'SESSION_CHANGED' });
      if (error) throw error;
      return ownerRequired ? classroomSnapshot(data, owner) : data;
    } catch (error) {
      if (revision !== epoch) throw Object.assign(new Error('계정 변경'), { code: 'SESSION_CHANGED' });
      throw error;
    } finally { clearTimeout(timer); pending.delete(controller); }
  }
  return {
    setUser,
    status: () => request('classroom_backend_status', {}, false),
    load: () => request('load_classroom', {}),
    async save(input, { expectedRevision = null, result = null } = {}) {
      if (writing) throw Object.assign(new Error('저장 중'), { code: 'SAVE_IN_PROGRESS' });
      const payload = snapshotPayload(input, result);
      writing = true;
      try { return await request('save_classroom', { p_snapshot: payload, p_expected_revision: expectedRevision }); }
      finally { writing = false; }
    },
  };
}

// Keep auth requests out of auth-state callbacks. No password is persisted here.
export function createAuthService(client, redirectUrl) {
  return {
    async submit(values, mode) {
      const issue = validateCredentials(values, mode);
      if (issue) throw Object.assign(new Error(issue), { code: 'INVALID_CREDENTIALS_INPUT' });
      const credentials = { email: values.email.trim().toLowerCase(), password: values.password };
      const { data, error } = mode === 'signup'
        ? await client.auth.signUp({ ...credentials, options: { emailRedirectTo: redirectUrl } })
        : await client.auth.signInWithPassword(credentials);
      if (error) throw error;
      return data;
    },
    async resend(email) {
      if (validateCredentials({ email, password: 'present' })) throw Object.assign(new Error('올바른 이메일 주소를 입력해 주세요.'), { code: 'INVALID_CREDENTIALS_INPUT' });
      const { error } = await client.auth.resend({ type: 'signup', email: email.trim().toLowerCase(), options: { emailRedirectTo: redirectUrl } });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
  };
}
