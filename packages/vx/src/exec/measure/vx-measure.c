/*
 * vx-measure: the process that forks a Linux task's shell, so its peak
 * memory is its own.
 *
 * Bun spawns with vfork, and at exec Linux keeps the old memory's
 * high-water mark, vx's, in the child's maxrss: a shell vx spawned read at
 * least vx's size in wait4. A fork of this small process starts clean. One
 * runs per vx, started at the first task (src/exec/spawn-off.ts), and forks
 * every task shell, so no task pays an exec of its own here.
 * docs/design/peak-memory-exact-2026-11.md.
 *
 *   fd 3: a SOCK_SEQPACKET socket; each message is one request:
 *     spawn {1, id, nfds, ignored, argc, envc} file\0 cwd\0 argv\0... env\0...
 *           with the task's descriptors (SCM_RIGHTS), slot order, those in
 *           the `ignored` mask left out (they get /dev/null)
 *     kill  {2, id, signal, pid, 0, 0}
 *   fd 4: a pipe; each write is one record of 40 bytes:
 *     {kind, id, pid, status, maxrss KiB (u64), utime us (u64), stime us (u64)}
 *     kind 0 hello (once, before any request is read), 1 spawned,
 *     2 exited (status as wait4 gives it), 3 declined (vx spawns it itself)
 *
 * The child leads its own session (as Bun's `detached` made the shell),
 * gets the descriptors at 0..nfds-1 and nothing else, an empty signal mask,
 * the directory, and execs. This process ends when vx closes the socket.
 *
 * It is each shell's parent, so a task's `kill -TERM $PPID` reaches it, not
 * vx: every signal it can catch is passed on to vx. Like vx it is not
 * dumpable, so no task reads its memory or environment.
 *
 * No libc: one file builds for x86_64 and aarch64 with any clang, and the
 * binary is a few kilobytes vx embeds (scripts/build-observe.ts).
 */

typedef unsigned long u64;
typedef unsigned int u32;

#if defined(__x86_64__)
enum {
  NR_read = 0, NR_write = 1, NR_close = 3, NR_rt_sigprocmask = 14, NR_recvmsg = 47,
  NR_clone = 56, NR_execve = 59, NR_wait4 = 61, NR_kill = 62, NR_fcntl = 72, NR_chdir = 80,
  NR_setsid = 112, NR_exit_group = 231, NR_openat = 257, NR_faccessat = 269, NR_ppoll = 271,
  NR_signalfd4 = 289, NR_dup3 = 292, NR_getppid = 110, NR_prctl = 157,
};
#elif defined(__aarch64__)
enum {
  NR_read = 63, NR_write = 64, NR_close = 57, NR_rt_sigprocmask = 135, NR_recvmsg = 212,
  NR_clone = 220, NR_execve = 221, NR_wait4 = 260, NR_kill = 129, NR_fcntl = 25, NR_chdir = 49,
  NR_setsid = 157, NR_exit_group = 94, NR_openat = 56, NR_faccessat = 48, NR_ppoll = 73,
  NR_signalfd4 = 74, NR_dup3 = 24, NR_getppid = 173, NR_prctl = 167,
};
#else
#error "vx-measure builds for x86_64 and aarch64"
#endif

enum {
  NR_close_range = 436, SIGCHLD = 17, EINTR = 4, EAGAIN = 11, F_DUPFD_CLOEXEC = 1030,
  SIG_BLOCK = 0, SIG_SETMASK = 2, AT_FDCWD = -100, X_OK = 1, O_RDONLY = 0, O_WRONLY = 1,
  O_CLOEXEC = 02000000, SFD_CLOEXEC = 02000000, SFD_NONBLOCK = 04000, WNOHANG = 1,
  MSG_CMSG_CLOEXEC = 0x40000000, MSG_TRUNC = 0x20, MSG_CTRUNC = 0x8, SOL_SOCKET = 1,
  SCM_RIGHTS = 1, POLLIN = 1, PR_SET_DUMPABLE = 4,
};

enum { REQ = 3, REPLY = 4, MAX_FDS = 16, MAX_PTRS = 16384, MAX_LIVE = 4096, FD_HIGH = 64 };
enum { HELLO = 0, SPAWNED = 1, EXITED = 2, DECLINED = 3 };

static long sys(long nr, long a, long b, long c, long d, long e, long f) {
#if defined(__x86_64__)
  register long r10 __asm__("r10") = d;
  register long r8 __asm__("r8") = e;
  register long r9 __asm__("r9") = f;
  long ret;
  __asm__ volatile("syscall"
                   : "=a"(ret)
                   : "a"(nr), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
                   : "rcx", "r11", "memory");
  return ret;
#else
  register long x8 __asm__("x8") = nr;
  register long x0 __asm__("x0") = a;
  register long x1 __asm__("x1") = b;
  register long x2 __asm__("x2") = c;
  register long x3 __asm__("x3") = d;
  register long x4 __asm__("x4") = e;
  register long x5 __asm__("x5") = f;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5) : "memory");
  return x0;
#endif
}
#define S0(n) sys(n, 0, 0, 0, 0, 0, 0)
#define S1(n, a) sys(n, (long)(a), 0, 0, 0, 0, 0)
#define S2(n, a, b) sys(n, (long)(a), (long)(b), 0, 0, 0, 0)
#define S3(n, a, b, c) sys(n, (long)(a), (long)(b), (long)(c), 0, 0, 0)
#define S4(n, a, b, c, d) sys(n, (long)(a), (long)(b), (long)(c), (long)(d), 0, 0)
#define S5(n, a, b, c, d, e) sys(n, (long)(a), (long)(b), (long)(c), (long)(d), (long)(e), 0)

/* The compiler may call these for a struct's copy or zeroing. */
void *memcpy(void *d, const void *s, u64 n) {
  char *o = d;
  const char *i = s;
  while (n--) *o++ = *i++;
  return d;
}
void *memset(void *d, int c, u64 n) {
  char *o = d;
  while (n--) *o++ = (char)c;
  return d;
}

/* ru_utime and ru_stime (seconds, microseconds), then ru_maxrss in KiB. */
struct rusage {
  long utime[2], stime[2], maxrss, rest[11];
};
struct iovec {
  void *base;
  u64 len;
};
struct msghdr {
  void *name;
  u32 namelen, pad0;
  struct iovec *iov;
  u64 iovlen;
  void *control;
  u64 controllen;
  int flags, pad1;
};
struct cmsghdr {
  u64 len;
  int level, type;
};
struct pollfd {
  int fd;
  short events, revents;
};
struct record {
  u32 kind, id;
  int pid, status;
  u64 maxrss, utime, stime;
};

/* One request at a time: a task's whole environment fits. */
static char req[256 * 1024];
static u64 control[(sizeof(struct cmsghdr) + MAX_FDS * sizeof(int)) / 8 + 1];
static char *ptrs[MAX_PTRS];
static struct {
  u32 id;
  int pid;
} live[MAX_LIVE];
static int nlive;

static void reply(u32 kind, u32 id, int pid, int status, const struct rusage *ru) {
  struct record r = {kind, id, pid, status, 0, 0, 0};
  if (ru) {
    r.maxrss = (u64)ru->maxrss;
    r.utime = (u64)ru->utime[0] * 1000000 + (u64)ru->utime[1];
    r.stime = (u64)ru->stime[0] * 1000000 + (u64)ru->stime[1];
  }
  /* vx is gone: nothing is left to tell. */
  long e;
  while ((e = S3(NR_write, REPLY, &r, sizeof r)) == -EINTR) {
  }
  if (e < 0) S1(NR_exit_group, 0);
}

static void say(const char *s) {
  long n = 0;
  while (s[n]) n++;
  S3(NR_write, 2, s, n);
}

static void reap(void) {
  int st;
  struct rusage ru;
  for (;;) {
    ru.maxrss = 0;
    long pid = S4(NR_wait4, -1, &st, WNOHANG, &ru);
    if (pid <= 0) return;
    for (int i = 0; i < nlive; i++)
      if (live[i].pid == pid) {
        reply(EXITED, live[i].id, (int)pid, st, &ru);
        live[i] = live[--nlive];
        break;
      }
  }
}

/* In the child: become the task's shell, or end 127 saying why not. */
static void become(int nfds, const int *fds, const char *file, const char *cwd, char **argv,
                   char **envp) {
  S0(NR_setsid);
  u64 none = 0;
  S4(NR_rt_sigprocmask, SIG_SETMASK, &none, 0, 8);
  /* Above every target first, so no move lands on a descriptor still to be moved. */
  int high[MAX_FDS];
  for (int i = 0; i < nfds; i++) high[i] = (int)S3(NR_fcntl, fds[i], F_DUPFD_CLOEXEC, FD_HIGH);
  for (int i = 0; i < nfds; i++) S3(NR_dup3, high[i], i, 0);
  if (S3(NR_close_range, nfds, ~0u, 0) < 0)
    for (int i = nfds; i < 1024; i++) S1(NR_close, i);
  if (cwd[0] && S1(NR_chdir, cwd) < 0) {
    say("vx: cannot enter the task's directory\n");
    S1(NR_exit_group, 127);
  }
  S3(NR_execve, file, argv, envp);
  say("vx: cannot exec the task's shell\n");
  S1(NR_exit_group, 127);
}

static void spawn(const u32 *h, long n, const int *got, int ngot) {
  u32 id = h[1], nfds = h[2], ignored = h[3], argc = h[4], envc = h[5];
  int fds[MAX_FDS];
  int opened[MAX_FDS];
  int nopened = 0;
  int ok = nfds <= MAX_FDS && argc + envc + 2 <= MAX_PTRS && nlive < MAX_LIVE;
  /* The strings: file, cwd, argv, env, each NUL-ended within the message. */
  char *file = req + 24, *end = req + n;
  u32 want = 2 + argc + envc, k = 0;
  for (char *p = file; ok && p < end && k < want; p++)
    if (*p == 0) k++;
  ok = ok && k == want;
  char *cwd = file;
  if (ok) {
    char *p = file;
    while (*p++) {
    }
    cwd = p;
    while (*p++) {
    }
    /* ptrs: argv, NULL, env, NULL. */
    for (u32 i = 0; i < argc + 1 + envc; i++) {
      if (i == argc) {
        ptrs[i] = 0;
        continue;
      }
      ptrs[i] = p;
      while (*p++) {
      }
    }
    ptrs[argc + 1 + envc] = 0;
  }
  int used = 0;
  for (u32 i = 0; ok && i < nfds; i++) {
    if (ignored & (1u << i)) {
      long fd = S4(NR_openat, AT_FDCWD, "/dev/null", (i == 0 ? O_RDONLY : O_WRONLY) | O_CLOEXEC, 0);
      if (fd < 0) ok = 0;
      else fds[i] = opened[nopened++] = (int)fd;
    } else if (used < ngot) fds[i] = got[used++];
    else ok = 0;
  }
  ok = ok && used == ngot && file[0] == '/' && S4(NR_faccessat, AT_FDCWD, file, X_OK, 0) == 0 &&
       (!cwd[0] || S4(NR_faccessat, AT_FDCWD, cwd, X_OK, 0) == 0);
  long pid = -1;
  if (ok) pid = S5(NR_clone, SIGCHLD, 0, 0, 0, 0);
  if (pid == 0) become((int)nfds, fds, file, cwd, ptrs, ptrs + argc + 1);
  for (int i = 0; i < ngot; i++) S1(NR_close, got[i]);
  for (int i = 0; i < nopened; i++) S1(NR_close, opened[i]);
  if (pid < 0) return reply(DECLINED, id, 0, 0, 0);
  live[nlive].id = id;
  live[nlive].pid = (int)pid;
  nlive++;
  reply(SPAWNED, id, (int)pid, 0, 0);
}

static void request(void) {
  struct iovec iov = {req, sizeof req};
  struct msghdr m = {0, 0, 0, &iov, 1, control, sizeof control, 0, 0};
  long n = S3(NR_recvmsg, REQ, &m, MSG_CMSG_CLOEXEC);
  if (n == -EINTR || n == -EAGAIN) return;
  /* vx closed its end: the run is over. */
  if (n <= 0) S1(NR_exit_group, 0);
  int got[MAX_FDS];
  int ngot = 0;
  for (struct cmsghdr *c = (struct cmsghdr *)control;
       m.controllen >= sizeof *c && (char *)c + sizeof *c <= (char *)control + m.controllen;) {
    if (c->len < sizeof *c) break;
    if (c->level == SOL_SOCKET && c->type == SCM_RIGHTS) {
      int *fd = (int *)(c + 1);
      for (u64 i = 0; i < (c->len - sizeof *c) / sizeof(int); i++)
        if (ngot < MAX_FDS) got[ngot++] = fd[i];
        else S1(NR_close, fd[i]);
    }
    c = (struct cmsghdr *)((char *)c + ((c->len + 7) & ~7ul));
  }
  const u32 *h = (const u32 *)req;
  if (n < 24 || (m.flags & (MSG_TRUNC | MSG_CTRUNC))) {
    for (int i = 0; i < ngot; i++) S1(NR_close, got[i]);
    if (n >= 8 && h[0] == 1) reply(DECLINED, h[1], 0, 0, 0);
    return;
  }
  if (h[0] == 1) return spawn(h, n, got, ngot);
  for (int i = 0; i < ngot; i++) S1(NR_close, got[i]);
  /* Only a child not yet reaped: its pid cannot have been reused. */
  if (h[0] == 2)
    for (int i = 0; i < nlive; i++)
      if (live[i].pid == (int)h[3]) S2(NR_kill, h[3], h[2]);
}

static void main_(void) {
  /* Every signal through a descriptor: SIGCHLD reaps, the rest go to vx. */
  u64 all = ~0ul;
  S4(NR_rt_sigprocmask, SIG_BLOCK, &all, 0, 8);
  long vx = S0(NR_getppid);
  long sfd = S4(NR_signalfd4, -1, &all, 8, SFD_CLOEXEC | SFD_NONBLOCK);
  if (sfd < 0) S1(NR_exit_group, 1);
  S5(NR_prctl, PR_SET_DUMPABLE, 0, 0, 0, 0);
  reply(HELLO, 0, 0, 0, 0);
  /* signalfd_siginfo: ssi_signo first, 128 bytes each. */
  u32 info[32 * 4];
  for (;;) {
    struct pollfd p[2] = {{REQ, POLLIN, 0}, {(int)sfd, POLLIN, 0}};
    if (S5(NR_ppoll, p, 2, 0, 0, 8) < 0) continue;
    if (p[1].revents) {
      int chld = 0;
      for (long n; (n = S3(NR_read, sfd, info, sizeof info)) > 0;)
        for (long i = 0; i < n / 128; i++) {
          u32 sig = info[i * 32];
          if (sig == SIGCHLD) chld = 1;
          /* Only to the vx that started it: once it is gone, no one. */
          else if (S0(NR_getppid) == vx) S2(NR_kill, vx, sig);
        }
      if (chld) reap();
    }
    if (p[0].revents) request();
  }
}

void start_c(long *sp) {
  (void)sp;
  main_();
  S1(NR_exit_group, 0);
}

#if defined(__x86_64__)
__asm__(".globl _start\n_start:\n  xor %rbp, %rbp\n  mov %rsp, %rdi\n  and $-16, %rsp\n  call start_c\n");
#else
__asm__(".globl _start\n_start:\n  mov x29, #0\n  mov x0, sp\n  bl start_c\n");
#endif
