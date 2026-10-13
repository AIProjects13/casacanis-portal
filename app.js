// Portal Casa Canis — Fase 0: acceso, roles, aprobación de clientes y empleados.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, onAuthStateChanged, signOut, sendEmailVerification,
  sendPasswordResetEmail, updatePassword, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { getFirestore, doc, onSnapshot, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { ico } from './icons.js';

// ====================================================================
// 1. Configuración (la configuración web de Firebase es pública por diseño)
// ====================================================================
const CONFIG = {
  firebase: {
    apiKey: 'AIzaSyASyXuzH5HvZL0LWsmazvg-6iW4bqO4snk',
    authDomain: 'casacanis-dd642.firebaseapp.com',
    projectId: 'casacanis-dd642',
    storageBucket: 'casacanis-dd642.firebasestorage.app',
    messagingSenderId: '616453134402',
    appId: '1:616453134402:web:64fa0850adb6c84a9fb5db',
  },
  sitio: 'https://www.casacanisgt.com',
  terminos: 'https://www.casacanisgt.com/terminos-condiciones.html',
  inactividadMin: 30,
  puestos: ['Recepción', 'Caja', 'Grooming', 'Cuidado y hospedaje', 'Veterinaria', 'Fisioterapia', 'Entrenamiento', 'Transporte', 'Administración', 'Otro'],
};
const EMU = new URLSearchParams(location.search).get('emulador') === '1' && ['localhost', '127.0.0.1'].includes(location.hostname);

const fapp = initializeApp(CONFIG.firebase);
const auth = getAuth(fapp);
const fns = getFunctions(fapp, 'us-central1');
const fdb = getFirestore(fapp);
if (EMU) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  connectFirestoreEmulator(fdb, '127.0.0.1', 8080);
}
const call = httpsCallable(fns, 'api');

// ====================================================================
// 2. Estado
// ====================================================================
const S = {
  user: null, me: null, users: [], registrando: false, busy: false, ultimaMutacion: 0,
  filtro: { q: '', estado: 'TODOS' }, filtroEmp: '',
  semana: null, ag: {}, idsTareas: null,
};
let unsubs = [];
let timerRecarga = null;
let timerInactividad = null;

// ====================================================================
// 3. Utilidades
// ====================================================================
const $ = (s, r = document) => r.querySelector(s);
const root = () => $('#root');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function mensajeAuth(e) {
  const c = e?.code || '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(c)) return 'Correo o contraseña incorrectos.';
  if (c === 'auth/email-already-in-use') return 'Ya existe una cuenta con ese correo. Inicia sesión.';
  if (c === 'auth/weak-password') return 'La contraseña es muy débil. Usa al menos 10 caracteres.';
  if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  if (c === 'auth/network-request-failed' || c === 'functions/unavailable') return 'No hay conexión. Revisa tu internet e inténtalo de nuevo.';
  if (c === 'auth/requires-recent-login') return 'Por seguridad, cierra sesión y vuelve a entrar para cambiar tu contraseña.';
  return e?.message && !c.startsWith('auth/') && !c.startsWith('functions/') ? e.message : 'No se pudo completar la acción. Inténtalo de nuevo.';
}

async function api(action, payload = {}) {
  let r;
  try { r = await call({ action, payload }); } catch (e) { throw Object.assign(new Error(mensajeAuth(e)), { code: e.code }); }
  const b = r.data;
  if (!b || !b.ok) throw Object.assign(new Error(b?.error?.message || 'No se pudo completar la acción.'), { code: b?.error?.code });
  return b.data;
}

async function withBusy(fn) {
  S.busy = true;
  try { return await fn(); } finally { S.busy = false; }
}

const fecha = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—');
const ROL = { ADMIN: 'Administrador', EMPLEADO: 'Empleado', CLIENTE: 'Cliente' };
const badgeEstado = (e) => ({
  PENDIENTE: '<span class="badge b-warn">Pendiente</span>', APROBADO: '<span class="badge b-good">Aprobado</span>',
  RECHAZADO: '<span class="badge b-risk">Rechazado</span>', SUSPENDIDO: '<span class="badge b-gray">Suspendido</span>',
}[e] || '');

// ====================================================================
// 4. Ventanas modales
// ====================================================================
function openModal({ title, body, submitLabel = 'Guardar', danger = false, onSubmit }) {
  const host = $('#modal-root');
  host.innerHTML = `<div class="overlay"><form class="modal" novalidate>
      <h2>${esc(title)}</h2><div class="m-error"></div>${body}
      <div class="foot"><button type="button" class="btn btn-ghost" data-close>Cancelar</button>
      <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel)}</button></div></form></div>`;
  const form = $('form', host);
  const close = () => { host.innerHTML = ''; };
  $('[data-close]', host).onclick = close;
  $('.overlay', host).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    $('.m-error', form).innerHTML = '';
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      close();
    } catch (err) {
      $('.m-error', form).innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      toast(err.message, true);
      btn.disabled = false;
    }
  });
  const first = $('input:not([type=hidden]),select,textarea', form);
  if (first) first.focus();
}

// ====================================================================
// 5. Acceso: iniciar sesión, registrarse, estados de cuenta
// ====================================================================
function authShell(inner) {
  S.vistaPrev = null;
  root().innerHTML = `<div class="auth-wrap">
    <aside class="auth-brand">
      <div class="logo-badge"><img src="logo.png" alt="Casa Canis"></div>
      <div><h2>Bienestar, seguridad y <span>felicidad</span> para quienes más amas.</h2>
        <p>Tu portal para reservar, dar seguimiento a las visitas de tu mascota y comprar en Casa Canis.</p></div>
      <small>Casa Canis · Dog Hotel &amp; Resort · Guatemala</small>
    </aside>
    <section class="auth-panel"><div><div class="auth-card">${inner}</div>
      <a class="back-site" href="${CONFIG.sitio}">← Volver al sitio de Casa Canis</a></div></section></div>`;
}

function renderAuth(tab = 'login', aviso = '') {
  authShell(`
    <h1>Portal Casa Canis</h1>
    <p class="sub">Clientes y equipo de trabajo</p>
    <div class="tabs"><button data-tab="login" class="${tab === 'login' ? 'active' : ''}">Iniciar sesión</button>
    <button data-tab="registro" class="${tab === 'registro' ? 'active' : ''}">Crear cuenta</button></div>
    ${aviso ? `<div class="form-ok">${esc(aviso)}</div>` : ''}
    <div id="auth-error"></div>
    ${tab === 'login' ? `
      <form id="f-login" novalidate>
        <div class="field"><label>Correo electrónico</label><input name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-dark btn-full" type="submit">Entrar</button>
        <div class="auth-foot"><button type="button" class="link" id="olvide">¿Olvidaste tu contraseña?</button></div>
      </form>` : `
      <form id="f-registro" novalidate>
        <div class="field"><label>Nombre completo</label><input name="nombre" autocomplete="name" required></div>
        <div class="form-grid">
          <div class="field"><label>Teléfono</label><input name="telefono" type="tel" autocomplete="tel" placeholder="5555 1234" required></div>
          <div class="field"><label>Correo electrónico</label><input name="email" type="email" autocomplete="email" required></div>
        </div>
        <div class="form-grid">
          <div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="new-password" required><small>Mínimo 10 caracteres</small></div>
          <div class="field"><label>Repite la contraseña</label><input name="password2" type="password" autocomplete="new-password" required></div>
        </div>
        <label class="check"><input type="checkbox" name="terminos"><span>Acepto los <a class="link" href="${CONFIG.terminos}" target="_blank" rel="noopener">Términos y Condiciones</a></span></label>
        <button class="btn btn-dark btn-full" type="submit">Crear mi cuenta</button>
        <p class="auth-foot" style="color:var(--gray-dark)">Tu cuenta será revisada por nuestro equipo antes de poder reservar.</p>
      </form>`}`);
  const err = (m) => { $('#auth-error').innerHTML = `<div class="form-error">${esc(m)}</div>`; };
  $('.tabs').onclick = (e) => { const t = e.target.dataset.tab; if (t) renderAuth(t); };

  if (tab === 'login') {
    $('#olvide').onclick = async () => {
      const email = ($('#f-login [name=email]').value || '').trim();
      if (!email) return err('Escribe tu correo arriba y vuelve a tocar "¿Olvidaste tu contraseña?".');
      try { await sendPasswordResetEmail(auth, email); } catch (e) { /* respuesta genérica a propósito */ }
      renderAuth('login', 'Si el correo está registrado, te enviamos un enlace para crear una contraseña nueva.');
    };
    $('#f-login').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      try { await signInWithEmailAndPassword(auth, String(f.get('email')).trim(), String(f.get('password'))); }
      catch (x) { err(mensajeAuth(x)); btn.disabled = false; }
    };
  } else {
    $('#f-registro').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.password !== f.password2) return err('Las contraseñas no coinciden.');
      if (String(f.password).length < 10) return err('La contraseña debe tener al menos 10 caracteres.');
      if (!f.terminos) return err('Debes aceptar los términos y condiciones.');
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      S.registrando = true;
      try {
        const cred = await createUserWithEmailAndPassword(auth, String(f.email).trim(), String(f.password));
        await api('registrarCliente', { nombre: f.nombre, telefono: f.telefono, aceptaTerminos: true });
        sendEmailVerification(cred.user).catch(() => {});
        S.registrando = false;
        await cargar();
      } catch (x) {
        S.registrando = false;
        if (auth.currentUser) await cargar(); else { err(mensajeAuth(x)); btn.disabled = false; }
        if (auth.currentUser) toast(mensajeAuth(x), true);
      }
    };
  }
}

function renderCompletar() {
  authShell(`<h1>Completa tu registro</h1><p class="sub">Necesitamos unos datos para crear tu perfil de cliente.</p>
    <div id="auth-error"></div>
    <form id="f-comp" novalidate>
      <div class="field"><label>Nombre completo</label><input name="nombre" required></div>
      <div class="field"><label>Teléfono</label><input name="telefono" type="tel" required></div>
      <label class="check"><input type="checkbox" name="terminos"><span>Acepto los <a class="link" href="${CONFIG.terminos}" target="_blank" rel="noopener">Términos y Condiciones</a></span></label>
      <button class="btn btn-dark btn-full" type="submit">Continuar</button>
      <div class="auth-foot"><button type="button" class="link" id="salir">Cerrar sesión</button></div>
    </form>`);
  $('#salir').onclick = () => signOut(auth);
  $('#f-comp').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('registrarCliente', { nombre: f.nombre, telefono: f.telefono, aceptaTerminos: !!f.terminos }); await cargar(); }
    catch (x) { $('#auth-error').innerHTML = `<div class="form-error">${esc(x.message)}</div>`; }
  };
}

function renderVerificar() {
  authShell(`<h1>Verifica tu correo</h1><p class="sub">Para continuar, abre el enlace que te enviamos por correo y vuelve a entrar.</p>
    <button class="btn btn-dark btn-full" id="salir">Cerrar sesión</button>`);
  $('#salir').onclick = () => signOut(auth);
}

function renderEstadoCliente() {
  const m = S.me;
  const info = {
    PENDIENTE: ['clock', 'b-warn', 'Tu cuenta está en revisión', 'Nuestro equipo la revisará pronto. Te avisaremos aquí cuando esté aprobada y podrás reservar y hacer pedidos.'],
    RECHAZADO: ['x', 'b-risk', 'Tu cuenta no fue aprobada', 'Comunícate con nosotros por WhatsApp para más información.'],
    SUSPENDIDO: ['x', 'b-gray', 'Tu cuenta está suspendida', 'Comunícate con nosotros por WhatsApp para resolverlo.'],
  }[m.Estado];
  authShell(`<div class="estado-icon ${info[1]}">${ico(info[0], 30)}</div><h1>${info[2]}</h1>
    <p class="sub">Hola, ${esc(m.Nombre)}. ${info[3]}</p>
    ${!m.EmailVerificado ? '<div class="form-ok">Revisa tu correo: te enviamos un enlace para verificarlo.</div>' : ''}
    <button class="btn btn-ghost btn-full" id="reload">Actualizar estado</button>
    <div class="auth-foot"><button type="button" class="link" id="salir">Cerrar sesión</button></div>`);
  $('#salir').onclick = () => signOut(auth);
  $('#reload').onclick = () => cargar();
}

function renderCambioClave() {
  authShell(`<h1>Crea tu contraseña</h1><p class="sub">Por seguridad, cambia la contraseña temporal que te dieron.</p>
    <div id="auth-error"></div>
    <form id="f-clave" novalidate>
      <div class="field"><label>Contraseña nueva</label><input name="p1" type="password" autocomplete="new-password" required><small>Mínimo 10 caracteres</small></div>
      <div class="field"><label>Repite la contraseña</label><input name="p2" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-dark btn-full" type="submit">Guardar y continuar</button>
      <div class="auth-foot"><button type="button" class="link" id="salir">Cerrar sesión</button></div>
    </form>`);
  $('#salir').onclick = () => signOut(auth);
  $('#f-clave').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const err = (m) => { $('#auth-error').innerHTML = `<div class="form-error">${esc(m)}</div>`; };
    if (f.p1 !== f.p2) return err('Las contraseñas no coinciden.');
    if (f.p1.length < 10) return err('La contraseña debe tener al menos 10 caracteres.');
    try { await updatePassword(auth.currentUser, f.p1); await api('passwordChanged'); await cargar(); }
    catch (x) { err(mensajeAuth(x)); }
  };
}

function renderError(msg) {
  authShell(`<h1>No pudimos cargar tu información</h1><p class="sub">${esc(msg)}</p>
    <button class="btn btn-dark btn-full" id="r">Reintentar</button>
    <div class="auth-foot"><button type="button" class="link" id="salir">Cerrar sesión</button></div>`);
  $('#r').onclick = () => cargar();
  $('#salir').onclick = () => signOut(auth);
}

// ====================================================================
// 6. Carga de datos y tiempo real
// ====================================================================
async function cargar(silencioso = false) {
  try {
    const d = await api('getSnapshot');
    S.me = d.me; S.users = d.users || [];
    if (!S.semana) S.semana = lunesDe(hoyGT());
    if (S.me.Rol === 'ADMIN' || S.me.Rol === 'EMPLEADO') {
      const actual = lunesDe(hoyGT());
      await Promise.all([cargarAgenda(actual), S.semana !== actual ? cargarAgenda(S.semana) : null]).catch(() => {});
    }
    escuchar();
    iniciarInactividad();
    render();
  } catch (e) {
    if (silencioso) return;
    if (e.code === 'NOT_REGISTERED') return renderCompletar();
    if (e.code === 'EMAIL_NOT_VERIFIED') return renderVerificar();
    if (e.code === 'UNAUTHENTICATED') { await signOut(auth); return; }
    renderError(e.message);
  }
}

function detener() { unsubs.forEach((u) => u()); unsubs = []; escuchando = false; clearTimeout(timerInactividad); }

let escuchando = false;
async function escuchar() {
  if (escuchando || !S.user) return;
  escuchando = true;
  const ids = [S.user.uid];
  if (S.me.Rol === 'ADMIN') { await S.user.getIdToken(true).catch(() => {}); ids.push('_admin'); }
  ids.forEach((id) => {
    let primero = true;
    unsubs.push(onSnapshot(doc(fdb, 'senales', id), () => {
      if (primero) { primero = false; return; }
      if (Date.now() - S.ultimaMutacion < 2000) return; // cambio hecho desde esta pantalla
      programarRecarga();
    }, () => {}));
  });
}

function programarRecarga() {
  clearTimeout(timerRecarga);
  timerRecarga = setTimeout(function intentar() {
    const el = document.activeElement;
    const escribiendo = el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    if (S.busy || $('#modal-root .modal') || escribiendo || document.hidden) { timerRecarga = setTimeout(intentar, 3000); return; }
    cargar(true);
  }, 800);
}

let inactividadActiva = false;
function reiniciarInactividad() {
  clearTimeout(timerInactividad);
  timerInactividad = setTimeout(() => signOut(auth), CONFIG.inactividadMin * 60000);
}
function iniciarInactividad() {
  if (!inactividadActiva) {
    inactividadActiva = true;
    ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, reiniciarInactividad, { passive: true }));
  }
  reiniciarInactividad();
}

async function mutar(accion, payload, mensaje) {
  await withBusy(() => api(accion, payload));
  S.ultimaMutacion = Date.now();
  await cargar();
  if (mensaje) toast(mensaje);
}

// ====================================================================
// 7. Navegación y estructura
// ====================================================================
const NAV = {
  ADMIN: [['inicio', 'home', 'Inicio'], ['agenda', 'calendar', 'Agenda'], ['clientes', 'users', 'Clientes'], ['empleados', 'briefcase', 'Empleados'], ['perfil', 'user', 'Mi perfil']],
  EMPLEADO: [['inicio', 'home', 'Inicio'], ['agenda', 'calendar', 'Mi agenda'], ['perfil', 'user', 'Mi perfil']],
  CLIENTE: [['inicio', 'home', 'Inicio'], ['perfil', 'user', 'Mi perfil']],
};
const VIEWS = { inicio: vistaInicio, agenda: vistaAgenda, clientes: vistaClientes, empleados: vistaEmpleados, perfil: vistaPerfil };

const vistaActual = () => {
  const v = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'inicio';
  return NAV[S.me.Rol].some((n) => n[0] === v) ? v : 'inicio';
};

function render() {
  const m = S.me;
  if (m.DebeCambiarClave === 'SI') return renderCambioClave();
  if (m.Rol === 'CLIENTE' && m.Estado !== 'APROBADO') return renderEstadoCliente();
  const v = vistaActual();
  const cambio = v !== S.vistaPrev;
  S.vistaPrev = v;
  const pendientes = S.users.filter((u) => u.Rol === 'CLIENTE' && u.Estado === 'PENDIENTE').length;
  const menuAbierto = $('.shell')?.classList.contains('menu-open');
  const scroll = window.scrollY;
  root().innerHTML = `<div class="shell ${menuAbierto ? 'menu-open' : ''}">
    <aside class="sidebar">
      <div class="brand"><div class="logo-mini"><img src="logo.png" alt=""></div><div><span>Casa Canis</span><small>Portal</small></div></div>
      <nav class="nav">${NAV[m.Rol].map(([id, ic, tit]) => `<a href="#/${id}" class="${id === v ? 'active' : ''}">${ico(ic)} ${tit}${id === 'clientes' && pendientes ? `<span class="badge-n">${pendientes}</span>` : ''}</a>`).join('')}</nav>
      <div class="user">${avatar(m.Nombre, 2)}<div class="meta"><b>${esc(m.Nombre)}</b><small>${ROL[m.Rol]}${m.Puesto ? ' · ' + esc(m.Puesto) : ''}</small></div>
        <button data-action="salir" title="Cerrar sesión" aria-label="Cerrar sesión">${ico('logout', 16)}</button></div>
    </aside>
    <div>
      <div class="topbar"><button data-action="menu" aria-label="Menú">${ico('menu', 22)}</button><span>Casa Canis</span></div>
      <main class="main ${cambio ? 'enter' : ''}">${VIEWS[v]()}</main>
    </div></div>`;
  if (cambio) { window.scrollTo(0, 0); contarNumeros(); } else window.scrollTo(0, scroll);
}

function avatar(nombre, v = 1) {
  const ini = String(nombre).trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return `<span class="avatar ${v === 2 ? 'v2' : v === 3 ? 'v3' : ''}">${esc(ini)}</span>`;
}
const variante = (nombre) => 1 + (String(nombre).length % 3);

function contarNumeros() {
  document.querySelectorAll('[data-count]').forEach((el) => {
    const fin = Number(el.dataset.count) || 0;
    if (!fin || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fin; return; }
    const t0 = performance.now();
    (function paso(t) {
      const p = Math.min((t - t0) / 800, 1);
      el.textContent = Math.round(fin * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(paso);
    })(t0);
  });
}

// ====================================================================
// 8. Vistas
// ====================================================================
function saludo() {
  const h = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Guatemala' })) % 24;
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}
function hoyTexto() {
  const t = new Date().toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Guatemala' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function vistaInicio() {
  const m = S.me;
  const head = `<div class="page-head"><div><span class="eyebrow">${hoyTexto()}</span><h1>${saludo()}, ${esc(m.Nombre.split(' ')[0])}</h1>
    <p>${ROL[m.Rol]}${m.Puesto ? ' · ' + esc(m.Puesto) : ''}</p></div></div>`;
  if (m.Rol === 'ADMIN') {
    const c = S.users.filter((u) => u.Rol === 'CLIENTE');
    const pend = c.filter((u) => u.Estado === 'PENDIENTE').length;
    const kp = (n, l, ic, extra = '') => `<div class="kpi ${extra}"><div class="chip">${ico(ic, 20)}</div><div class="n" data-count="${n}">0</div><div class="l">${l}</div></div>`;
    return `${head}<div class="grid-kpi">
      ${kp(pend, 'Clientes por aprobar', 'clock', pend ? 'accent' : '')}
      ${kp(c.filter((u) => u.Estado === 'APROBADO').length, 'Clientes aprobados', 'users')}
      ${kp(S.users.filter((u) => u.Rol === 'EMPLEADO' && u.Activo).length, 'Empleados activos', 'briefcase')}
      ${kp(((S.ag[lunesDe(hoyGT())] || { tareas: [] }).tareas).filter((t) => t.Fecha === hoyGT() && t.Estado !== 'CANCELADA').length, 'Tareas para hoy', 'calendar')}</div>
      <div class="quick">
        <a href="#/clientes"><span class="chip">${ico('check', 20)}</span><span>Revisar clientes<small>${pend ? pend + ' esperando aprobación' : 'Todo al día'}</small></span></a>
        <a href="#/agenda"><span class="chip">${ico('calendar', 20)}</span><span>Agenda del equipo<small>Horarios y tareas</small></span></a>
        <a href="#/empleados"><span class="chip">${ico('plus', 20)}</span><span>Agregar empleado<small>Crear cuenta del equipo</small></span></a>
      </div>
      <div class="card"><h2>Integridad de la bitácora</h2>
        <p style="color:var(--muted);font-size:.9rem;margin-bottom:1rem;max-width:620px">Cada alta, aprobación o baja queda registrada y protegida contra cambios. Aquí puedes comprobar que nada fue alterado.</p>
        <button class="btn btn-dark" data-action="verificar">${ico('shield', 16)} Verificar ahora</button><div id="res-audit" style="margin-top:1rem"></div></div>`;
  }
  if (m.Rol === 'EMPLEADO') {
    const ag = S.ag[lunesDe(hoyGT())];
    const hoy = hoyGT();
    const t = ag && turnoDe(ag, m.ID, hoy);
    const ts = ag ? ag.tareas.filter((x) => x.Fecha === hoy) : [];
    return `${head}<div class="card"><div class="card-top"><h2>Hoy</h2>${!t ? '<span class="badge b-gray">Sin horario</span>' : t.Tipo === 'TRABAJO' ? `<span class="badge b-good">${t.Entrada}–${t.Salida}</span>` : `<span class="badge b-warn">${TIPOS[t.Tipo]}</span>`}</div>
      ${t && t.Tipo === 'TRABAJO' && (t.AlmuerzoInicio || t.PuestoDia) ? `<p class="muted-line">${t.AlmuerzoInicio ? `Almuerzo ${t.AlmuerzoInicio}–${t.AlmuerzoFin}` : ''}${t.PuestoDia ? ` · Puesto del día: ${esc(t.PuestoDia)}` : ''}</p>` : ''}
      ${ts.length ? ts.map((x) => tareaFila(x, false)).join('') : '<p class="muted-line">No tienes tareas para hoy.</p>'}</div>
      <div class="quick"><a href="#/agenda"><span class="chip">${ico('calendar', 20)}</span><span>Ver mi semana<small>Horario y tareas</small></span></a></div>`;
  }
  return `${head}<div class="card"><h2>Tu cuenta está activa</h2>
    <p style="color:var(--muted)">${m.Rol === 'CLIENTE' ? 'Pronto podrás registrar a tus perros, reservar servicios y hacer pedidos desde aquí.' : 'Pronto verás aquí tu horario, tus tareas y tus citas asignadas.'}</p></div>`;
}

function vistaClientes() {
  const { q, estado } = S.filtro;
  const lista = S.users.filter((u) => u.Rol === 'CLIENTE')
    .filter((u) => estado === 'TODOS' || u.Estado === estado)
    .filter((u) => !q || norm(`${u.Nombre} ${u.Email} ${u.Telefono}`).includes(norm(q)));
  return `<div class="page-head"><div><span class="eyebrow">Administración</span><h1>Clientes</h1><p>Aprueba las cuentas nuevas y administra a los clientes.</p></div></div>
    <div class="toolbar"><input id="q-cli" placeholder="Buscar por nombre, correo o teléfono" value="${esc(q)}">
      <select id="e-cli">${['TODOS', 'PENDIENTE', 'APROBADO', 'RECHAZADO', 'SUSPENDIDO'].map((e) => `<option value="${e}" ${e === estado ? 'selected' : ''}>${e === 'TODOS' ? 'Todos los estados' : e[0] + e.slice(1).toLowerCase()}</option>`).join('')}</select></div>
    <div class="card"><div class="table-wrap">${lista.length ? `<table><thead><tr><th>Cliente</th><th>Contacto</th><th>Registro</th><th>Estado</th><th></th></tr></thead><tbody>
      ${lista.map((u) => `<tr><td><div class="person">${avatar(u.Nombre, variante(u.Nombre))}<div><b>${esc(u.Nombre)}</b><div class="sub">${u.EmailVerificado ? 'Correo verificado' : 'Correo sin verificar'}</div></div></div></td>
        <td>${esc(u.Email)}<div class="sub">${esc(u.Telefono)}</div></td><td>${fecha(u.FechaCreacion)}</td><td>${badgeEstado(u.Estado)}${u.EstadoMotivo ? `<div class="sub">${esc(u.EstadoMotivo)}</div>` : ''}</td>
        <td class="acciones">
          ${u.Estado !== 'APROBADO' ? `<button class="btn btn-primary btn-sm" data-action="estado" data-id="${u.ID}" data-e="APROBADO">${ico('check', 14)} Aprobar</button>` : ''}
          ${u.Estado === 'PENDIENTE' ? `<button class="btn btn-ghost btn-sm" data-action="estado" data-id="${u.ID}" data-e="RECHAZADO">Rechazar</button>` : ''}
          ${u.Estado === 'APROBADO' ? `<button class="btn btn-ghost btn-sm" data-action="estado" data-id="${u.ID}" data-e="SUSPENDIDO">Suspender</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-action="borrar" data-id="${u.ID}" title="Eliminar">${ico('trash', 14)}</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No hay clientes que coincidan.</div>'}</div></div>`;
}

function vistaEmpleados() {
  const lista = S.users.filter((u) => u.Rol === 'EMPLEADO').filter((u) => !S.filtroEmp || norm(`${u.Nombre} ${u.Email} ${u.Puesto}`).includes(norm(S.filtroEmp)));
  return `<div class="page-head"><div><span class="eyebrow">Equipo</span><h1>Empleados</h1><p>Solo el administrador crea las cuentas del equipo.</p></div>
      <button class="btn btn-primary" data-action="nuevoEmp">${ico('plus', 16)} Nuevo empleado</button></div>
    <div class="toolbar"><input id="q-emp" placeholder="Buscar empleado" value="${esc(S.filtroEmp)}"></div>
    <div class="card"><div class="table-wrap">${lista.length ? `<table><thead><tr><th>Nombre</th><th>Puesto</th><th>Contacto</th><th>Estado</th><th></th></tr></thead><tbody>
      ${lista.map((u) => `<tr><td><div class="person">${avatar(u.Nombre, variante(u.Nombre))}<b>${esc(u.Nombre)}</b></div></td><td>${esc(u.Puesto)}</td><td>${esc(u.Email)}<div class="sub">${esc(u.Telefono)}</div></td>
        <td>${u.Activo ? '<span class="badge b-good">Activo</span>' : '<span class="badge b-gray">Desactivado</span>'}${u.DebeCambiarClave === 'SI' ? ' <span class="badge b-warn">Clave temporal</span>' : ''}</td>
        <td class="acciones"><button class="btn btn-ghost btn-sm" data-action="editarEmp" data-id="${u.ID}">${ico('edit', 14)} Editar</button>
        <button class="btn btn-ghost btn-sm" data-action="borrar" data-id="${u.ID}" title="Eliminar">${ico('trash', 14)}</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">Aún no hay empleados. Crea el primero con "Nuevo empleado".</div>'}</div></div>`;
}

function vistaPerfil() {
  const m = S.me;
  return `<div class="page-head"><div><span class="eyebrow">Cuenta</span><h1>Mi perfil</h1><p>Tus datos de contacto.</p></div><button class="btn btn-primary" data-action="editarPerfil">${ico('edit', 16)} Editar</button></div>
    <div class="card"><dl class="profile-grid">
      <div><dt>Nombre</dt><dd>${esc(m.Nombre)}</dd></div><div><dt>Correo</dt><dd>${esc(m.Email)}</dd></div>
      <div><dt>Teléfono</dt><dd>${esc(m.Telefono) || '—'}</dd></div><div><dt>Dirección</dt><dd>${esc(m.Direccion) || '—'}</dd></div>
      <div><dt>Rol</dt><dd>${ROL[m.Rol]}${m.Puesto ? ' · ' + esc(m.Puesto) : ''}</dd></div><div><dt>Cuenta creada</dt><dd>${fecha(m.FechaCreacion)}</dd></div>
    </dl></div>`;
}

// ====================================================================
// 8b. Agenda: horarios del personal y tareas
// ====================================================================
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DIAS_LARGO = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TIPOS = { TRABAJO: 'Trabaja', LIBRE: 'Libre', VACACIONES: 'Vacaciones', ENFERMEDAD: 'Enfermedad', PERMISO: 'Permiso', AUSENTE: 'Ausente' };
const ESTADOS_T = { PENDIENTE: ['Pendiente', 'b-warn'], EN_CURSO: ['En curso', 'b-info'], HECHA: ['Hecha', 'b-good'], CANCELADA: ['Cancelada', 'b-gray'] };

function hoyGT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' }); }
function sumar(f, n) { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lunesDe(f) { const d = new Date(`${f}T00:00:00Z`); return sumar(f, -((d.getUTCDay() + 6) % 7)); }
const fdm = (f) => `${Number(f.slice(8))} ${MESES[Number(f.slice(5, 7)) - 1]}`;
const dowDe = (f) => (new Date(`${f}T00:00:00Z`).getUTCDay() + 6) % 7;

async function cargarAgenda(semana) {
  const d = await api('getAgenda', { semana });
  S.ag[semana] = d;
  if (S.me.Rol === 'EMPLEADO') {
    const ids = new Set(d.tareas.map((t) => t.TareaID));
    if (S.idsTareas) {
      d.tareas.filter((t) => !S.idsTareas.has(t.TareaID) && t.CreadaPor !== S.me.ID).forEach((t) => toast(`Nueva tarea asignada: ${t.Titulo} (${fdm(t.Fecha)} ${t.Inicio})`));
      ids.forEach((i) => S.idsTareas.add(i));
    } else S.idsTareas = ids;
  }
}

function cargandoAgenda() {
  if (!S.agPidiendo) {
    S.agPidiendo = true;
    cargarAgenda(S.semana).catch((e) => { S.ag[S.semana] = { semana: S.semana, turnos: [], tareas: [] }; toast(e.message, true); })
      .finally(() => { S.agPidiendo = false; render(); });
  }
  return '<div class="splash" style="min-height:40vh"><div class="spinner"></div></div>';
}

const turnoDe = (ag, emp, f) => ag.turnos.find((t) => t.EmpleadoID === emp && t.Fecha === f);
const empleadosActivos = () => S.users.filter((u) => u.Rol === 'EMPLEADO' && u.Activo !== false).sort((a, b) => a.Nombre.localeCompare(b.Nombre, 'es'));

function navSemana() {
  const fin = sumar(S.semana, 6);
  const actual = S.semana === lunesDe(hoyGT());
  return `<div class="weeknav"><button class="btn btn-ghost btn-icon" data-action="sem" data-d="-7" aria-label="Semana anterior">${ico('left', 16)}</button>
    <div class="weeklabel"><b>${fdm(S.semana)} – ${fdm(fin)} ${fin.slice(0, 4)}</b><small>${actual ? 'Esta semana' : 'Semana del ' + fdm(S.semana)}</small></div>
    <button class="btn btn-ghost btn-icon" data-action="sem" data-d="7" aria-label="Semana siguiente">${ico('right', 16)}</button>
    ${actual ? '' : '<button class="btn btn-ghost btn-sm" data-action="semHoy">Ir a hoy</button>'}</div>`;
}

function textoTurno(t) {
  if (!t) return '';
  if (t.Tipo !== 'TRABAJO') return TIPOS[t.Tipo];
  return `${t.Entrada} – ${t.Salida}${t.AlmuerzoInicio ? ` · almuerzo ${t.AlmuerzoInicio}–${t.AlmuerzoFin}` : ''}${t.PuestoDia ? ` · ${t.PuestoDia}` : ''}`;
}

function celdaTurno(t, emp, f, hoy) {
  const cls = !t ? 'vacio' : t.Tipo === 'TRABAJO' ? 'trabajo' : t.Tipo === 'LIBRE' ? 'libre' : 'ausencia';
  const inner = !t ? '<span>+ Asignar</span>'
    : t.Tipo === 'TRABAJO' ? `<b>${t.Entrada}–${t.Salida}</b><small>${t.PuestoDia ? esc(t.PuestoDia) : (t.AlmuerzoInicio ? 'Almuerzo ' + t.AlmuerzoInicio : 'Sin almuerzo')}</small>`
    : `<b>${TIPOS[t.Tipo]}</b>`;
  return `<td class="${f === hoy ? 'hoy' : ''}"><button class="celda ${cls}" data-action="editarTurno" data-emp="${emp}" data-fecha="${f}" title="${esc(textoTurno(t) || 'Sin horario')}">${inner}</button></td>`;
}

function tareaFila(t, admin) {
  const [lbl, cl] = ESTADOS_T[t.Estado] || ['', ''];
  const btns = admin
    ? `<button class="btn btn-ghost btn-sm" data-action="editarTarea" data-id="${t.TareaID}">${ico('edit', 14)}</button>
       ${t.Estado !== 'CANCELADA' ? `<button class="btn btn-ghost btn-sm" data-action="tareaEstado" data-id="${t.TareaID}" data-e="CANCELADA">Cancelar</button>` : `<button class="btn btn-ghost btn-sm" data-action="tareaEstado" data-id="${t.TareaID}" data-e="PENDIENTE">Reactivar</button>`}
       <button class="btn btn-ghost btn-sm" data-action="borrarTarea" data-id="${t.TareaID}" aria-label="Eliminar">${ico('trash', 14)}</button>`
    : `${t.Estado === 'PENDIENTE' ? `<button class="btn btn-ghost btn-sm" data-action="tareaEstado" data-id="${t.TareaID}" data-e="EN_CURSO">${ico('play', 12)} Iniciar</button>` : ''}
       ${t.Estado === 'PENDIENTE' || t.Estado === 'EN_CURSO' ? `<button class="btn btn-primary btn-sm" data-action="tareaEstado" data-id="${t.TareaID}" data-e="HECHA">${ico('check', 14)} Hecha</button>` : ''}
       ${t.Estado === 'HECHA' ? `<button class="btn btn-ghost btn-sm" data-action="tareaEstado" data-id="${t.TareaID}" data-e="PENDIENTE">Reabrir</button>` : ''}`;
  return `<div class="task ${t.Estado === 'CANCELADA' ? 'cancelada' : ''}">
    <div class="t-time"><b>${t.Inicio}</b><small>${t.Fin}</small></div>
    <div class="t-body"><b>${esc(t.Titulo)}</b>${t.Descripcion ? `<p>${esc(t.Descripcion)}</p>` : ''}
      ${admin ? `<div class="t-meta">${avatar(t.EmpleadoNombre, variante(t.EmpleadoNombre))}<span>${esc(t.EmpleadoNombre)}</span></div>` : ''}</div>
    <div class="t-side"><span class="badge ${cl}">${lbl}</span><div class="t-btns">${btns}</div></div></div>`;
}

function listaTareasSemana(ag, admin) {
  const dias = [0, 1, 2, 3, 4, 5, 6].map((i) => sumar(S.semana, i));
  const bloques = dias.map((f) => {
    const ts = ag.tareas.filter((t) => t.Fecha === f);
    if (!ts.length) return '';
    return `<div class="day-group"><h3>${DIAS_LARGO[dowDe(f)]} <small>${fdm(f)}</small></h3>${ts.map((t) => tareaFila(t, admin)).join('')}</div>`;
  }).join('');
  return bloques || '<div class="empty">No hay tareas esta semana.</div>';
}

function vistaAgenda() {
  const ag = S.ag[S.semana];
  if (!ag) return cargandoAgenda();
  return S.me.Rol === 'ADMIN' ? agendaAdmin(ag) : agendaEmpleado(ag);
}

function agendaAdmin(ag) {
  const emps = empleadosActivos();
  const dias = [0, 1, 2, 3, 4, 5, 6].map((i) => sumar(S.semana, i));
  const hoy = hoyGT();
  const head = `<div class="page-head"><div><span class="eyebrow">Equipo</span><h1>Agenda</h1><p>Horarios del personal y tareas asignadas.</p></div>
    <div class="head-actions">${navSemana()}</div></div>`;
  if (!emps.length) return `${head}<div class="card"><div class="empty">Aún no hay empleados activos. Crea el primero en la sección Empleados.</div></div>`;
  const sinHorario = !ag.turnos.length;
  const cobertura = dias.map((f) => {
    const t = ag.turnos.filter((x) => x.Fecha === f && x.Tipo === 'TRABAJO');
    return `<td class="${f === hoy ? 'hoy' : ''}"><div class="cob"><b>${t.length}</b><small>${t.length === 1 ? 'persona' : 'personas'}</small></div></td>`;
  }).join('');
  return `${head}
    ${sinHorario ? `<div class="banner"><div><b>Esta semana aún no tiene horarios.</b> Copia la semana anterior y ajusta lo necesario, o créalos día por día.</div>
      <button class="btn btn-primary btn-sm" data-action="copiarSemana">${ico('copy', 14)} Copiar semana anterior</button></div>` : ''}
    <div class="card"><div class="card-top"><h2>Horarios del equipo</h2>
      ${sinHorario ? '' : `<button class="btn btn-ghost btn-sm" data-action="copiarSemana">${ico('copy', 14)} Copiar semana anterior</button>`}</div>
      <div class="table-wrap"><table class="agenda-grid"><thead><tr><th>Empleado</th>${dias.map((f, i) => `<th class="${f === hoy ? 'hoy' : ''}">${DIAS[i]}<small>${fdm(f)}</small></th>`).join('')}</tr></thead><tbody>
        ${emps.map((e) => `<tr><td class="emp"><div class="person">${avatar(e.Nombre, variante(e.Nombre))}<div><b>${esc(e.Nombre)}</b><div class="sub">${esc(e.Puesto)}</div></div></div></td>
          ${dias.map((f) => celdaTurno(turnoDe(ag, e.ID, f), e.ID, f, hoy)).join('')}</tr>`).join('')}
        <tr class="cobertura"><td class="emp"><b>Cobertura</b><div class="sub">Quiénes trabajan</div></td>${cobertura}</tr>
      </tbody></table></div></div>
    <div class="card"><div class="card-top"><h2>Tareas de la semana</h2>
      <button class="btn btn-primary btn-sm" data-action="nuevaTarea">${ico('plus', 14)} Nueva tarea</button></div>${listaTareasSemana(ag, true)}</div>`;
}

function agendaEmpleado(ag) {
  const dias = [0, 1, 2, 3, 4, 5, 6].map((i) => sumar(S.semana, i));
  const hoy = hoyGT();
  return `<div class="page-head"><div><span class="eyebrow">Mi trabajo</span><h1>Mi agenda</h1><p>Tu horario y las tareas que te asignaron.</p></div>
    <div class="head-actions">${navSemana()}</div></div>
    <div class="week-cards">${dias.map((f, i) => {
      const t = turnoDe(ag, S.me.ID, f);
      const ts = ag.tareas.filter((x) => x.Fecha === f);
      const chip = !t ? '<span class="badge b-gray">Sin horario</span>' : t.Tipo === 'TRABAJO' ? `<span class="badge b-good">${t.Entrada}–${t.Salida}</span>` : `<span class="badge b-warn">${TIPOS[t.Tipo]}</span>`;
      return `<div class="card day-card ${f === hoy ? 'es-hoy' : ''}"><div class="card-top"><h2>${DIAS_LARGO[i]} <small>${fdm(f)}${f === hoy ? ' · Hoy' : ''}</small></h2>${chip}</div>
        ${t && t.Tipo === 'TRABAJO' && (t.AlmuerzoInicio || t.PuestoDia) ? `<p class="muted-line">${t.AlmuerzoInicio ? `Almuerzo ${t.AlmuerzoInicio}–${t.AlmuerzoFin}` : ''}${t.PuestoDia ? ` · Puesto del día: ${esc(t.PuestoDia)}` : ''}</p>` : ''}
        ${ts.length ? ts.map((x) => tareaFila(x, false)).join('') : '<p class="muted-line">Sin tareas.</p>'}</div>`;
    }).join('')}</div>`;
}

// Formularios
function opcionesEmpleados(sel) {
  return empleadosActivos().map((e) => `<option value="${e.ID}" ${e.ID === sel ? 'selected' : ''}>${esc(e.Nombre)} · ${esc(e.Puesto)}</option>`).join('');
}

function formTurno(empId, f) {
  const e = S.users.find((u) => u.ID === empId);
  const t = turnoDe(S.ag[S.semana], empId, f) || {};
  const tipo = t.Tipo || 'TRABAJO';
  const hora = (n, v, d) => `<div class="field"><label>${n.l}</label><input type="time" name="${n.n}" value="${v || d}"></div>`;
  openModal({
    title: `Horario de ${e.Nombre.split(' ')[0]}`,
    body: `<p style="color:var(--muted);margin-bottom:1rem">${DIAS_LARGO[dowDe(f)]} ${fdm(f)} ${f.slice(0, 4)}</p>
      <div class="field"><label>Tipo de día</label><select name="tipo" id="tipo-turno">${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${k === tipo ? 'selected' : ''}>${v}</option>`).join('')}${t.Tipo ? '<option value="SIN_HORARIO">Quitar horario de este día</option>' : ''}</select></div>
      <div id="campos-trabajo" class="${tipo === 'TRABAJO' ? '' : 'hidden'}">
        <div class="form-grid">${hora({ l: 'Entrada', n: 'entrada' }, t.Entrada, '08:00')}${hora({ l: 'Salida', n: 'salida' }, t.Salida, '16:00')}</div>
        <div class="form-grid">${hora({ l: 'Inicio de almuerzo', n: 'almuerzoInicio' }, t.AlmuerzoInicio, t.Tipo ? '' : '12:00')}${hora({ l: 'Fin de almuerzo', n: 'almuerzoFin' }, t.AlmuerzoFin, t.Tipo ? '' : '13:00')}</div>
        <div class="field"><label>Puesto de este día</label><select name="puestoDia"><option value="">Su puesto habitual (${esc(e.Puesto)})</option>${CONFIG.puestos.map((p) => `<option ${t.PuestoDia === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <small>Recepción y Caja dan acceso a ver las fichas de clientes ese día.</small></div></div>
      <div class="field"><label>Nota (opcional)</label><input name="nota" value="${esc(t.Nota || '')}" maxlength="200"></div>`,
    submitLabel: 'Guardar horario',
    onSubmit: (v) => mutar('saveTurno', { empleadoId: empId, fecha: f, tipo: v.tipo, entrada: v.entrada, salida: v.salida, almuerzoInicio: v.almuerzoInicio, almuerzoFin: v.almuerzoFin, puestoDia: v.puestoDia, nota: v.nota }, 'Horario guardado.'),
  });
}

function formTarea(t, defecto = {}) {
  openModal({
    title: t ? 'Editar tarea' : 'Nueva tarea',
    body: `<div class="field"><label>Título</label><input name="titulo" value="${esc(t?.Titulo || '')}" placeholder="Ej. Baño y corte de Rocky" maxlength="120"></div>
      <div class="field"><label>Detalle (opcional)</label><textarea name="descripcion" rows="2" maxlength="500">${esc(t?.Descripcion || '')}</textarea></div>
      <div class="field"><label>Asignar a</label><select name="empleadoId">${opcionesEmpleados(t?.EmpleadoID || defecto.emp)}</select></div>
      <div class="form-grid"><div class="field"><label>Fecha</label><input type="date" name="fecha" value="${t?.Fecha || defecto.fecha || hoyGT()}"></div><div></div></div>
      <div class="form-grid"><div class="field"><label>Inicio</label><input type="time" name="inicio" value="${t?.Inicio || '09:00'}"></div>
        <div class="field"><label>Fin</label><input type="time" name="fin" value="${t?.Fin || '10:00'}"></div></div>
      <small style="color:var(--muted)">Si la persona ya tiene algo a esa hora, está de descanso o fuera de su horario, la app no te dejará guardar y te dirá por qué.</small>`,
    submitLabel: t ? 'Guardar cambios' : 'Asignar tarea',
    onSubmit: (v) => mutar('saveTarea', { ...v, id: t?.TareaID }, t ? 'Tarea actualizada.' : 'Tarea asignada.'),
  });
}

function buscarTarea(id) {
  for (const k of Object.keys(S.ag)) { const t = S.ag[k].tareas.find((x) => x.TareaID === id); if (t) return t; }
  return null;
}

// ====================================================================
// 9. Acciones (delegación global de clics y cambios)
// ====================================================================
const campo = (n, l, v = '', extra = '') => `<div class="field"><label>${l}</label><input name="${n}" value="${esc(v)}" ${extra}></div>`;

const ACTIONS = {
  salir: () => signOut(auth),
  menu: () => $('.shell')?.classList.toggle('menu-open'),

  verificar: async () => {
    const out = $('#res-audit');
    out.innerHTML = '<div class="spinner" style="width:24px;height:24px;border-width:3px"></div>';
    try {
      const r = await api('verifyAudit');
      out.innerHTML = r.ok
        ? `<div class="form-ok">Todo en orden: ${r.total} registros verificados y sin alteraciones.</div>`
        : `<div class="form-error"><b>Se detectaron problemas:</b><ul style="margin:.4rem 0 0 1.1rem">${r.errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    } catch (e) { out.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  },

  estado: (el) => {
    const id = el.dataset.id; const e = el.dataset.e;
    const u = S.users.find((x) => x.ID === id);
    const pide = e === 'RECHAZADO' || e === 'SUSPENDIDO';
    openModal({
      title: { APROBADO: 'Aprobar cuenta', RECHAZADO: 'Rechazar cuenta', SUSPENDIDO: 'Suspender cuenta' }[e],
      body: `<p style="margin-bottom:1rem">${esc(u.Nombre)} · ${esc(u.Email)}</p>${pide ? '<div class="field"><label>Motivo (el cliente no lo verá)</label><textarea name="motivo" rows="3" placeholder="Mínimo 10 caracteres"></textarea></div>' : '<p style="color:var(--gray-dark)">El cliente podrá reservar servicios y hacer pedidos.</p>'}`,
      submitLabel: { APROBADO: 'Aprobar', RECHAZADO: 'Rechazar', SUSPENDIDO: 'Suspender' }[e], danger: pide,
      onSubmit: (f) => mutar('setClientEstado', { id, estado: e, motivo: f.motivo }, 'Listo, cuenta actualizada.'),
    });
  },

  borrar: (el) => {
    const u = S.users.find((x) => x.ID === el.dataset.id);
    openModal({
      title: 'Eliminar cuenta', danger: true, submitLabel: 'Eliminar definitivamente',
      body: `<p style="margin-bottom:1rem">Vas a eliminar a <b>${esc(u.Nombre)}</b> (${esc(u.Email)}). Esta acción no se puede deshacer.</p>
        <div class="field"><label>Justificación</label><textarea name="justificacion" rows="3" placeholder="Mínimo 10 caracteres"></textarea></div>`,
      onSubmit: (f) => mutar('deleteUser', { id: u.ID, justificacion: f.justificacion }, 'Cuenta eliminada.'),
    });
  },

  sem: async (el) => {
    S.semana = sumar(S.semana, Number(el.dataset.d));
    if (!S.ag[S.semana]) await cargarAgenda(S.semana).catch((e) => toast(e.message, true));
    render();
  },
  semHoy: async () => { S.semana = lunesDe(hoyGT()); await cargarAgenda(S.semana).catch(() => {}); render(); },
  editarTurno: (el) => formTurno(el.dataset.emp, el.dataset.fecha),
  nuevaTarea: () => formTarea(null),
  editarTarea: (el) => formTarea(buscarTarea(el.dataset.id)),
  borrarTarea: (el) => {
    const t = buscarTarea(el.dataset.id);
    openModal({ title: 'Eliminar tarea', danger: true, submitLabel: 'Eliminar',
      body: `<p>¿Eliminar «${esc(t.Titulo)}» de ${esc(t.EmpleadoNombre)}?</p>`,
      onSubmit: () => mutar('deleteTarea', { id: t.TareaID }, 'Tarea eliminada.') });
  },
  tareaEstado: async (el) => {
    try { await mutar('setTareaEstado', { id: el.dataset.id, estado: el.dataset.e }, 'Tarea actualizada.'); }
    catch (e) { toast(e.message, true); }
  },
  copiarSemana: () => {
    const origen = sumar(S.semana, -7);
    openModal({ title: 'Copiar semana anterior', submitLabel: 'Copiar horarios',
      body: `<p style="margin-bottom:.8rem">Se copiarán los horarios de la semana del <b>${fdm(origen)}</b> a esta semana (<b>${fdm(S.semana)}</b>).</p>
        <p style="color:var(--muted);font-size:.88rem">No se sobrescribe lo que ya exista. Las tareas no se copian. Después puedes ajustar cualquier día.</p>`,
      onSubmit: async () => {
        const r = await withBusy(() => api('copyWeek', { desde: origen, hacia: S.semana }));
        S.ultimaMutacion = Date.now(); await cargar();
        toast(r.copiados ? `Listo: se copiaron ${r.copiados} días de horario.` : 'No había horarios nuevos para copiar.');
      } });
  },
  nuevoEmp: () => formEmpleado(null),
  editarEmp: (el) => formEmpleado(S.users.find((x) => x.ID === el.dataset.id)),

  editarPerfil: () => {
    const m = S.me;
    openModal({
      title: 'Editar mi perfil',
      body: `${campo('nombre', 'Nombre completo', m.Nombre)}${campo('telefono', 'Teléfono', m.Telefono, 'type="tel"')}${campo('direccion', 'Dirección', m.Direccion)}`,
      onSubmit: (f) => mutar('updateProfile', f, 'Perfil actualizado.'),
    });
  },
};

function formEmpleado(u) {
  openModal({
    title: u ? 'Editar empleado' : 'Nuevo empleado',
    body: `${campo('nombre', 'Nombre completo', u?.Nombre)}
      <div class="form-grid">${campo('telefono', 'Teléfono', u?.Telefono, 'type="tel"')}
        <div class="field"><label>Puesto</label><select name="puesto">${CONFIG.puestos.map((p) => `<option ${u?.Puesto === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div></div>
      ${u ? `<p style="color:var(--gray-dark);font-size:.85rem;margin-bottom:1rem">Correo: ${esc(u.Email)}</p>` : campo('email', 'Correo electrónico', '', 'type="email"')}
      ${campo('clave', u ? 'Restablecer contraseña (opcional)' : 'Contraseña temporal', '', 'type="text" autocomplete="off" placeholder="Mínimo 10 caracteres"')}
      <small style="color:var(--gray-dark)">${u ? 'Déjala vacía para no cambiarla. ' : ''}El empleado deberá cambiarla al entrar por primera vez.</small>
      ${u ? `<label class="check" style="margin-top:1rem"><input type="checkbox" name="activo" ${u.Activo ? 'checked' : ''}><span>Cuenta activa</span></label>` : ''}`,
    submitLabel: u ? 'Guardar cambios' : 'Crear empleado',
    onSubmit: (f) => mutar('saveEmployee', { ...f, id: u?.ID, activo: u ? !!f.activo : true }, u ? 'Empleado actualizado.' : 'Empleado creado.'),
  });
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  ACTIONS[el.dataset.action]?.(el);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q-cli') { S.filtro.q = e.target.value; refiltrar('q-cli'); }
  if (e.target.id === 'q-emp') { S.filtroEmp = e.target.value; refiltrar('q-emp'); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'e-cli') { S.filtro.estado = e.target.value; render(); }
  if (e.target.id === 'tipo-turno') $('#campos-trabajo')?.classList.toggle('hidden', e.target.value !== 'TRABAJO');
});
function refiltrar(id) {
  const pos = document.getElementById(id)?.selectionStart;
  render();
  const el = document.getElementById(id);
  if (el) { el.focus(); el.setSelectionRange(pos, pos); }
}
window.addEventListener('hashchange', () => { if (S.me) { $('.shell')?.classList.remove('menu-open'); render(); } });

// ====================================================================
// 10. Arranque
// ====================================================================
(async () => {
  await setPersistence(auth, browserSessionPersistence);
  onAuthStateChanged(auth, async (u) => {
    S.user = u;
    if (!u) { detener(); S.me = null; S.users = []; renderAuth(); return; }
    if (S.registrando) return;
    await cargar();
  });
})();
