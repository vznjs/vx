/*
 * vx-observe: report the file calls of a command and everything it starts.
 *
 *   vx-observe <fd> <reads: 0|1> <program> [args...]
 *
 * The command runs under a seccomp filter that hands each file call to
 * this process (SECCOMP_RET_USER_NOTIF). Every call is let through
 * unchanged (SECCOMP_USER_NOTIF_FLAG_CONTINUE): this reports, the mount
 * table enforces. One line per reported call goes to <fd>:
 *
 *   a read call that will fail, as strace writes one (violations.ts reads both):
 *     <pid> openat(AT_FDCWD, "<path>", O_RDONLY) = -1 ENOENT (x)
 *   with <reads> 1, an open or readlink that will succeed:
 *     <pid> openat(AT_FDCWD, "<path>", O_RDONLY) = 3
 *   a call that writes, creates, removes, renames or changes a path:
 *     W <call> "<path>"
 *
 * Paths are absolute (a relative one is joined to the caller's cwd or
 * directory descriptor, read from /proc) and escaped as a C string. A
 * path is read from the caller's memory, which the caller can change
 * under us: a line is a report, never a decision.
 *
 * Why not strace: ptrace stops a tracee twice per traced call, and strace
 * stops a new child at EVERY call until its first traced one, 4 ms per
 * spawn from Bun, Node or Python (2026-11-17). A notification is one
 * round trip, and a new process costs nothing.
 *
 * No libc: one file builds for x86_64 and aarch64 with any clang, and the
 * binary is a few kilobytes vx embeds (scripts/build-observe.ts).
 *
 * The write calls and their arguments follow apply-seccomp.c's observer in
 * @anthropic-ai/sandbox-runtime (Apache-2.0), which this replaces where it
 * runs: the kernel allows one listener per task.
 */

typedef unsigned long u64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef long i64;

#if defined(__x86_64__)
#define ARCH 0xC000003Eu
enum {
  NR_read = 0, NR_write = 1, NR_close = 3, NR_ioctl = 16, NR_pipe2 = 293, NR_clone = 56,
  NR_execve = 59, NR_exit_group = 231, NR_wait4 = 61, NR_kill = 62, NR_getpid = 39,
  NR_prctl = 157, NR_seccomp = 317, NR_process_vm_readv = 310, NR_readlinkat = 267,
  NR_faccessat = 269, NR_faccessat2 = 439, NR_ppoll = 271, NR_rt_sigprocmask = 14,
  NR_signalfd4 = 289, NR_fcntl = 72, NR_openat = 257, NR_openat2 = 437,
  NR_unlinkat = 263, NR_mkdirat = 258, NR_mknodat = 259, NR_symlinkat = 266, NR_linkat = 265,
  NR_renameat = 264, NR_renameat2 = 316, NR_fchmodat = 268, NR_fchmodat2 = 452,
  NR_fchownat = 260, NR_utimensat = 280,
  NR_open = 2, NR_creat = 85, NR_access = 21, NR_readlink = 89, NR_unlink = 87, NR_rmdir = 84,
  NR_rename = 82, NR_link = 86, NR_symlink = 88, NR_mkdir = 83, NR_mknod = 133,
  NR_truncate = 76, NR_chmod = 90, NR_chown = 92, NR_lchown = 94, NR_utime = 132, NR_utimes = 235,
};
#define O_NOFOLLOW 0400000
#elif defined(__aarch64__)
#define ARCH 0xC00000B7u
enum {
  NR_read = 63, NR_write = 64, NR_close = 57, NR_ioctl = 29, NR_pipe2 = 59, NR_clone = 220,
  NR_execve = 221, NR_exit_group = 94, NR_wait4 = 260, NR_kill = 129, NR_getpid = 172,
  NR_prctl = 167, NR_seccomp = 277, NR_process_vm_readv = 270, NR_readlinkat = 78,
  NR_faccessat = 48, NR_faccessat2 = 439, NR_ppoll = 73, NR_rt_sigprocmask = 135,
  NR_signalfd4 = 74, NR_fcntl = 25, NR_openat = 56, NR_openat2 = 437,
  NR_unlinkat = 35, NR_mkdirat = 34, NR_mknodat = 33, NR_symlinkat = 36, NR_linkat = 37,
  NR_renameat = 38, NR_renameat2 = 276, NR_fchmodat = 53, NR_fchmodat2 = 452,
  NR_fchownat = 54, NR_utimensat = 88,
};
#define O_NOFOLLOW 0100000
#else
#error "vx-observe builds for x86_64 and aarch64"
#endif

enum {
  O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0100, O_TRUNC = 01000, O_APPEND = 02000,
  O_CLOEXEC = 02000000, O_PATH = 010000000,
  AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_EACCESS = 0x200,
  R_OK = 4, X_OK = 1, F_OK = 0,
  ENOENT = 2, EPERM = 1, EINTR = 4, EACCES = 13, EFAULT = 14, EINVAL = 22, ENOSYS = 38,
  SIGCHLD = 17,
  CLONE_FILES = 0x400,
  PR_SET_CHILD_SUBREAPER = 36, PR_SET_NO_NEW_PRIVS = 38,
  SECCOMP_SET_MODE_FILTER = 1,
  FLAG_NEW_LISTENER = 1 << 3, FLAG_TSYNC_ESRCH = 1 << 4, FLAG_WAIT_KILLABLE_RECV = 1 << 5,
  POLLIN = 1, POLLERR = 8, POLLHUP = 16,
  PATH_CAP = 4096,
};
#define WRITE_MASK (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)
#define RET_ALLOW 0x7fff0000u
#define RET_USER_NOTIF 0x7fc00000u
#define NOTIF_RECV 0xC0502100u
#define NOTIF_SEND 0xC0182101u
#define NOTIF_ID_VALID 0x40082102u
#define NOTIF_SET_FLAGS 0x40082104u

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
#define S6(n, a, b, c, d, e, f) sys(n, (long)(a), (long)(b), (long)(c), (long)(d), (long)(e), (long)(f))

/* The compiler may call these for a struct copy or a cleared buffer. */
void *memcpy(void *d, const void *s, u64 n) {
  u8 *a = d;
  const u8 *b = s;
  while (n--) *a++ = *b++;
  return d;
}
void *memset(void *d, int c, u64 n) {
  u8 *a = d;
  while (n--) *a++ = (u8)c;
  return d;
}

static u64 len(const char *s) {
  u64 n = 0;
  while (s[n]) n++;
  return n;
}

static void fail(const char *why) {
  static const char name[] = "vx-observe: ";
  S3(NR_write, 2, name, sizeof name - 1);
  S3(NR_write, 2, why, len(why));
  S3(NR_write, 2, "\n", 1);
  S1(NR_exit_group, 125);
}

static long number(const char *s) {
  long n = 0;
  int neg = *s == '-';
  if (neg) s++;
  if (!*s) return -1;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return -1;
    n = n * 10 + (*s - '0');
  }
  return neg ? -n : n;
}

/* ---- What is observed ------------------------------------------------- */

enum kind { OPEN, OPEN2, EXEC, ACCESS, READLINK, WRITE };

struct call {
  int nr;
  const char *name;
  u8 kind;
  signed char path, path2, flags, dirfd, dirfd2;
};

/* One table for the filter and the supervisor, so they cannot drift.
 * `flags` is the argument holding an open's flags or an access's mode. */
static const struct call CALLS[] = {
  {NR_openat, "openat", OPEN, 1, -1, 2, 0, -1},
  {NR_openat2, "openat2", OPEN2, 1, -1, -1, 0, -1},
  {NR_execve, "execve", EXEC, 0, -1, -1, -1, -1},
  {NR_faccessat, "faccessat", ACCESS, 1, -1, 2, 0, -1},
  {NR_faccessat2, "faccessat2", ACCESS, 1, -1, 2, 0, -1},
  {NR_readlinkat, "readlinkat", READLINK, 1, -1, -1, 0, -1},
  {NR_unlinkat, "unlinkat", WRITE, 1, -1, -1, 0, -1},
  {NR_mkdirat, "mkdirat", WRITE, 1, -1, -1, 0, -1},
  {NR_mknodat, "mknodat", WRITE, 1, -1, -1, 0, -1},
  {NR_symlinkat, "symlinkat", WRITE, 2, -1, -1, 1, -1},
  {NR_linkat, "linkat", WRITE, 1, 3, -1, 0, 2},
  {NR_renameat, "renameat", WRITE, 1, 3, -1, 0, 2},
  {NR_renameat2, "renameat2", WRITE, 1, 3, -1, 0, 2},
  {NR_fchmodat, "fchmodat", WRITE, 1, -1, -1, 0, -1},
  {NR_fchmodat2, "fchmodat2", WRITE, 1, -1, -1, 0, -1},
  {NR_fchownat, "fchownat", WRITE, 1, -1, -1, 0, -1},
  {NR_utimensat, "utimensat", WRITE, 1, -1, -1, 0, -1},
#if defined(__x86_64__)
  /* The calls before the *at forms: glibc and coreutils still make them
   * on x86_64. aarch64 never had them. */
  {NR_open, "open", OPEN, 0, -1, 1, -1, -1},
  {NR_access, "access", ACCESS, 0, -1, 1, -1, -1},
  {NR_readlink, "readlink", READLINK, 0, -1, -1, -1, -1},
  {NR_creat, "creat", WRITE, 0, -1, -1, -1, -1},
  {NR_unlink, "unlink", WRITE, 0, -1, -1, -1, -1},
  {NR_rmdir, "rmdir", WRITE, 0, -1, -1, -1, -1},
  {NR_rename, "rename", WRITE, 0, 1, -1, -1, -1},
  {NR_link, "link", WRITE, 0, 1, -1, -1, -1},
  {NR_symlink, "symlink", WRITE, 1, -1, -1, -1, -1},
  {NR_mkdir, "mkdir", WRITE, 0, -1, -1, -1, -1},
  {NR_mknod, "mknod", WRITE, 0, -1, -1, -1, -1},
  {NR_truncate, "truncate", WRITE, 0, -1, -1, -1, -1},
  {NR_chmod, "chmod", WRITE, 0, -1, -1, -1, -1},
  {NR_chown, "chown", WRITE, 0, -1, -1, -1, -1},
  {NR_lchown, "lchown", WRITE, 0, -1, -1, -1, -1},
  {NR_utime, "utime", WRITE, 0, -1, -1, -1, -1},
  {NR_utimes, "utimes", WRITE, 0, -1, -1, -1, -1},
#endif
};
#define NCALLS ((int)(sizeof CALLS / sizeof CALLS[0]))

static const struct call *find(int nr) {
  for (int i = 0; i < NCALLS; i++)
    if (CALLS[i].nr == nr) return &CALLS[i];
  return 0;
}

struct insn {
  u16 code;
  u8 jt, jf;
  u32 k;
};
struct prog {
  u16 n;
  struct insn *f;
};

/* load arch; other arch: allow. load nr; x32: allow. each call: notify. allow. */
static int filter(struct insn *f) {
  int n = 0;
  f[n++] = (struct insn){0x20, 0, 0, 4};
  f[n++] = (struct insn){0x15, 1, 0, ARCH};
  f[n++] = (struct insn){0x06, 0, 0, RET_ALLOW};
  f[n++] = (struct insn){0x20, 0, 0, 0};
#if defined(__x86_64__)
  f[n++] = (struct insn){0x35, 0, 1, 0x40000000u};
  f[n++] = (struct insn){0x06, 0, 0, RET_ALLOW};
#endif
  for (int i = 0; i < NCALLS; i++)
    f[n++] = (struct insn){0x15, (u8)(NCALLS - i), 0, (u32)CALLS[i].nr};
  f[n++] = (struct insn){0x06, 0, 0, RET_ALLOW};
  f[n++] = (struct insn){0x06, 0, 0, RET_USER_NOTIF};
  return n;
}

/* ---- The command's side ----------------------------------------------- */

/*
 * The child shares this process's descriptor table (CLONE_FILES), so the
 * listener it makes is ours too, and its number comes back on a pipe. Its
 * exec gives it a table of its own, where the listener, the pipe and the
 * report's descriptor (all close-on-exec) are closed. No socket: a
 * sandboxed command may be refused one.
 */
static void command(int tell, char **argv, char **envp, u64 *mask) {
  struct insn f[8 + NCALLS];
  struct prog p = {(u16)filter(f), f};
  /* A kernel before 5.5 refuses CONTINUE without ending the notification,
   * and the call would wait for good. No probe for a reply's flag: a
   * filter flag of the same release, with no program, answers EFAULT. */
  if (S3(NR_seccomp, SECCOMP_SET_MODE_FILTER, FLAG_TSYNC_ESRCH, 0) != -EFAULT)
    fail("this kernel cannot let an observed call through (Linux 5.5)");
  if (S5(NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("PR_SET_NO_NEW_PRIVS refused");
  /* WAIT_KILLABLE_RECV (5.19): a signal does not restart a call already
   * handed over, which a runtime that signals its own threads (Go) can
   * otherwise repeat without end. */
  long fd = S3(NR_seccomp, SECCOMP_SET_MODE_FILTER, FLAG_NEW_LISTENER | FLAG_WAIT_KILLABLE_RECV, &p);
  if (fd == -EINVAL) fd = S3(NR_seccomp, SECCOMP_SET_MODE_FILTER, FLAG_NEW_LISTENER, &p);
  if (fd < 0) fail("the seccomp listener was refused (another one is installed, or seccomp is off)");
  int n = (int)fd;
  if (S3(NR_write, tell, &n, sizeof n) != sizeof n) S1(NR_exit_group, 125);
  S4(NR_rt_sigprocmask, 2, mask, 0, 8);
  S3(NR_execve, argv[0], argv, envp);
  static const char why[] = "vx-observe: cannot exec the command\n";
  S3(NR_write, 2, why, sizeof why - 1);
  S1(NR_exit_group, 127);
}

/* ---- The supervisor's side -------------------------------------------- */

struct notif {
  u64 id;
  u32 pid, flags;
  int nr;
  u32 arch;
  u64 ip, args[6];
};
struct reply {
  u64 id;
  i64 val;
  int error;
  u32 flags;
};
struct iovec {
  void *base;
  u64 len;
};
struct pollfd {
  int fd;
  short events, revents;
};

static char out[1 << 16];
static u64 used;
static int report;

static void flush(void) {
  u64 at = 0;
  while (report >= 0 && at < used) {
    long w = S3(NR_write, report, out + at, used - at);
    if (w == -EINTR) continue;
    if (w <= 0) break;
    at += (u64)w;
  }
  used = 0;
}

static void put(const char *s, u64 n) {
  if (used + n > sizeof out) flush();
  if (n > sizeof out) return;
  memcpy(out + used, s, n);
  used += n;
}
static void puts_(const char *s) { put(s, len(s)); }

static void putn(long v) {
  char b[24];
  int i = sizeof b;
  int neg = v < 0;
  u64 u = neg ? (u64)-v : (u64)v;
  do b[--i] = (char)('0' + u % 10);
  while (u /= 10);
  if (neg) b[--i] = '-';
  put(b + i, sizeof b - (u64)i);
}

/* A quoted C string as strace writes one: octal for what is not printable ASCII. */
static void putq(const char *s, u64 n) {
  put("\"", 1);
  for (u64 i = 0; i < n; i++) {
    u8 c = (u8)s[i];
    if (c == '"' || c == '\\') {
      char e[2] = {'\\', (char)c};
      put(e, 2);
    } else if (c < 0x20 || c >= 0x7f) {
      char e[4] = {'\\', (char)('0' + (c >> 6)), (char)('0' + ((c >> 3) & 7)), (char)('0' + (c & 7))};
      put(e, 4);
    } else {
      put((const char *)&c, 1);
    }
  }
  put("\"", 1);
}

/* The NUL-ended string at `addr` in `pid`, a page at a time: a read that
 * runs into an unmapped page fails whole. Its length, or -1. */
static long remote(int pid, u64 addr, char *dst) {
  u64 got = 0;
  if (addr == 0) return -1;
  while (got < PATH_CAP - 1) {
    u64 page = 4096 - ((addr + got) & 4095);
    if (page > PATH_CAP - 1 - got) page = PATH_CAP - 1 - got;
    struct iovec l = {dst + got, page}, r = {(void *)(addr + got), page};
    long n = S6(NR_process_vm_readv, pid, &l, 1, &r, 1, 0);
    if (n <= 0) return -1;
    for (long i = 0; i < n; i++)
      if (dst[got + (u64)i] == 0) return (long)got + i;
    got += (u64)n;
  }
  return -1;
}

/* `rel` under the caller's cwd or directory descriptor, as /proc names
 * it. The caller is held in its call, so both are still. 0 when it cannot
 * be placed (the process is gone, the descriptor is a pipe). */
static u64 place(int pid, int dirfd, const char *rel, u64 rellen, char *dst) {
  char link[48];
  u64 o = 0;
  const char pre[] = "/proc/";
  memcpy(link, pre, 6);
  o = 6;
  char b[12];
  int i = sizeof b;
  u32 u = (u32)pid;
  do b[--i] = (char)('0' + u % 10);
  while (u /= 10);
  memcpy(link + o, b + i, sizeof b - (u64)i);
  o += sizeof b - (u64)i;
  if (dirfd == AT_FDCWD) {
    memcpy(link + o, "/cwd", 5);
  } else {
    if (dirfd < 0) return 0;
    memcpy(link + o, "/fd/", 4);
    o += 4;
    i = sizeof b;
    u = (u32)dirfd;
    do b[--i] = (char)('0' + u % 10);
    while (u /= 10);
    memcpy(link + o, b + i, sizeof b - (u64)i);
    o += sizeof b - (u64)i;
    link[o] = 0;
  }
  long n = S4(NR_readlinkat, AT_FDCWD, link, dst, PATH_CAP);
  if (n <= 0 || dst[0] != '/') return 0;
  if ((u64)n + 1 + rellen + 1 > 2 * PATH_CAP) return 0;
  o = (u64)n;
  if (o > 1) dst[o++] = '/';
  memcpy(dst + o, rel, rellen);
  o += rellen;
  dst[o] = 0;
  return o;
}

static int starts(const char *s, const char *with) {
  while (*with)
    if (*s++ != *with++) return 0;
  return 1;
}

/* `path` as this process must spell it to reach what `pid` means: the
 * caller's `/proc/self` is its own, and here it would be this one's. */
static const char *theirs(int pid, const char *path, u64 n) {
  static char own[2 * PATH_CAP + 32];
  u64 skip = starts(path, "/proc/self/") ? 10 : starts(path, "/proc/thread-self/") ? 17 : 0;
  if (skip == 0) return path;
  char b[12];
  int i = sizeof b;
  u32 u = (u32)pid;
  do b[--i] = (char)('0' + u % 10);
  while (u /= 10);
  u64 o = 6;
  memcpy(own, "/proc/", 6);
  memcpy(own + o, b + i, sizeof b - (u64)i);
  o += sizeof b - (u64)i;
  memcpy(own + o, path + skip, n - skip + 1);
  return own;
}

static long probe(int pid, const char *path, u64 n, int mode, int flags) {
  path = theirs(pid, path, n);
  long r = S4(NR_faccessat2, AT_FDCWD, path, mode, flags);
  if (r == -ENOSYS) r = S3(NR_faccessat, AT_FDCWD, path, mode);
  return r;
}

static const char *refusal(long r) {
  return r == -ENOENT ? "ENOENT" : r == -EACCES ? "EACCES" : r == -EPERM ? "EPERM" : 0;
}

/* `<pid> name(AT_FDCWD, "path"` or `<pid> name("path"`, as the call is spelled. */
static void head(int pid, const struct call *c, const char *path, u64 n) {
  putn(pid);
  puts_(" ");
  puts_(c->name);
  puts_(c->dirfd >= 0 ? "(AT_FDCWD, " : "(");
  putq(path, n);
}

static void failed(const char *errno_name) {
  puts_(" = -1 ");
  puts_(errno_name);
  puts_(" (x)\n");
}

static char raw[PATH_CAP], abs1[2 * PATH_CAP], abs2[2 * PATH_CAP];

/* The absolute path of argument `arg`, in `dst`; its length, 0 if unknown. */
static u64 path_of(const struct notif *q, int arg, int dirarg, char *dst) {
  if (arg < 0) return 0;
  long n = remote((int)q->pid, q->args[arg], raw);
  if (n <= 0) return 0;
  if (raw[0] == '/') {
    memcpy(dst, raw, (u64)n + 1);
    return (u64)n;
  }
  /* A descriptor argument is an int in a 64-bit register. */
  int dirfd = dirarg >= 0 ? (int)(u32)q->args[dirarg] : AT_FDCWD;
  return place((int)q->pid, dirfd, raw, (u64)n, dst);
}

static void observe(int listener, const struct notif *q, int reads) {
  const struct call *c = find(q->nr);
  if (c == 0) return;
  u64 n1 = path_of(q, c->path, c->dirfd, abs1);
  u64 n2 = path_of(q, c->path2, c->dirfd2, abs2);
  /* The caller may be gone and its pid another's: what was read is its only if it still waits. */
  if (S3(NR_ioctl, listener, NOTIF_ID_VALID, &q->id) != 0) return;
  int flags = c->flags >= 0 ? (int)(u32)q->args[c->flags] : 0;
  if (c->kind == WRITE || c->kind == OPEN2 || (c->kind == OPEN && (flags & WRITE_MASK))) {
    for (int k = 0; k < 2; k++) {
      u64 n = k == 0 ? n1 : n2;
      if (n == 0) continue;
      puts_("W ");
      puts_(c->name);
      puts_(" ");
      putq(k == 0 ? abs1 : abs2, n);
      puts_("\n");
    }
    return;
  }
  if (n1 == 0) return;
  if (c->kind == READLINK) {
    char one;
    long r = S4(NR_readlinkat, AT_FDCWD, theirs((int)q->pid, abs1, n1), &one, 1);
    const char *e = refusal(r);
    if (e == 0 && !(reads && r >= 0)) return;
    head((int)q->pid, c, abs1, n1);
    puts_(", \"\", 0)");
    if (e != 0) failed(e);
    else puts_(" = 1\n");
    return;
  }
  long r;
  int pid = (int)q->pid;
  if (c->kind == OPEN)
    r = probe(pid, abs1, n1, flags & O_PATH ? F_OK : R_OK, flags & O_NOFOLLOW ? AT_SYMLINK_NOFOLLOW : 0);
  else if (c->kind == EXEC) r = probe(pid, abs1, n1, X_OK, 0);
  else
    r = probe(pid, abs1, n1, flags & 7,
              c->nr == NR_faccessat2 ? (int)(u32)q->args[3] & (AT_EACCESS | AT_SYMLINK_NOFOLLOW) : 0);
  const char *e = refusal(r);
  if (e == 0 && !(reads && c->kind == OPEN && r == 0)) return;
  head((int)q->pid, c, abs1, n1);
  puts_(c->kind == OPEN ? ", O_RDONLY)" : c->kind == EXEC ? ", [], 0)" : ", F_OK)");
  if (e != 0) failed(e);
  else puts_(" = 3\n");
}

/* Exit as the command did: of its signal, so the shell reads the same status. */
static void leave(int status) {
  if ((status & 0x7f) != 0) {
    u64 none = 0;
    S4(NR_rt_sigprocmask, 2, &none, 0, 8);
    S2(NR_kill, S0(NR_getpid), status & 0x7f);
    S1(NR_exit_group, 128 + (status & 0x7f));
  }
  S1(NR_exit_group, (status >> 8) & 0xff);
}

/*
 * Three processes. This one keeps the pid the shell waits on and ends
 * with the command's status. The supervisor, its child, answers the
 * listener for as long as any process under the filter lives: a `server &`
 * the command leaves behind still opens files after the command is gone,
 * and with no one answering each such call fails ENOSYS. The command is
 * the supervisor's child, since a process may read another's memory only
 * as its ancestor (Yama).
 *
 * Every signal is blocked in the first two: vx signals the command's
 * process group, which holds all three, and the status reported must be
 * the command's own. The command gets its mask back before its exec.
 */
static void main_(int argc, char **argv, char **envp) {
  if (argc < 4) fail("usage: vx-observe <fd> <reads: 0|1> <program> [args...]");
  report = (int)number(argv[1]);
  int reads = argv[2][0] == '1';
  /* /proc must name this process tree by the pids the kernel reports. */
  char self[24];
  long sn = S4(NR_readlinkat, AT_FDCWD, "/proc/self", self, sizeof self - 1);
  if (sn <= 0) fail("/proc is not readable");
  self[sn] = 0;
  if (number(self) != S0(NR_getpid)) fail("/proc is another pid namespace's");

  u64 all = ~0ul, old = 0;
  S4(NR_rt_sigprocmask, 2, &all, &old, 8);
  int up[2];
  if (S2(NR_pipe2, up, O_CLOEXEC) < 0) fail("cannot make a pipe");
  long supervisor = S5(NR_clone, SIGCHLD, 0, 0, 0, 0);
  if (supervisor < 0) fail("cannot fork");
  if (supervisor != 0) {
    int status = 0;
    S1(NR_close, up[1]);
    /* No status: the supervisor died, and the command went unobserved. */
    if (S3(NR_read, up[0], &status, sizeof status) != sizeof status) fail("the supervisor ended before the command");
    leave(status);
  }
  S1(NR_close, up[0]);

  /* Orphans come to the supervisor, not to the namespace's init, so it stays their ancestor. */
  S5(NR_prctl, PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  u64 chld = 1ul << (SIGCHLD - 1);
  int signals = (int)S4(NR_signalfd4, -1, &chld, 8, O_CLOEXEC);
  int tell[2];
  if (signals < 0 || S2(NR_pipe2, tell, O_CLOEXEC) < 0) fail("cannot make a descriptor");
  if (report >= 0) S3(NR_fcntl, report, 2, 1);

  long child = S5(NR_clone, CLONE_FILES | SIGCHLD, 0, 0, 0, 0);
  if (child < 0) fail("cannot fork");
  if (child == 0) command(tell[1], argv + 3, envp, &old);
  /* The write end is the child's too until its exec: both ends close after the answer. */
  int listener = -1;
  struct pollfd first[2] = {{tell[0], POLLIN, 0}, {signals, POLLIN, 0}};
  int status = 0;
  for (;;) {
    if (S5(NR_ppoll, first, 2, 0, 0, 8) < 0) continue;
    if (first[0].revents & POLLIN) {
      if (S3(NR_read, tell[0], &listener, sizeof listener) != sizeof listener) listener = -1;
      break;
    }
    /* The child ended before it had a listener: its own message said why. */
    if (first[1].revents & POLLIN) {
      S4(NR_wait4, child, &status, 0, 0);
      S3(NR_write, up[1], &status, sizeof status);
      S1(NR_exit_group, 0);
    }
  }
  if (listener < 0) fail("the command sent no listener");
  S1(NR_close, tell[0]);
  S1(NR_close, tell[1]);
  u64 sync = 1;
  S3(NR_ioctl, listener, NOTIF_SET_FLAGS, &sync);

  static u8 qbuf[256], rbuf[64];
  struct notif *q = (struct notif *)qbuf;
  struct reply *r = (struct reply *)rbuf;
  struct pollfd fds[2] = {{listener, POLLIN, 0}, {signals, POLLIN, 0}};
  static const struct {
    long s, ns;
  } now = {0, 0};
  int told = 0;
  for (;;) {
    long pr = S5(NR_ppoll, fds, 2, used ? &now : 0, 0, 8);
    if (pr == 0) {
      flush();
      continue;
    }
    if (pr < 0) continue;
    if (fds[0].revents & POLLIN) {
      memset(qbuf, 0, sizeof qbuf);
      if (S3(NR_ioctl, listener, NOTIF_RECV, q) == 0) {
        observe(listener, q, reads);
        memset(rbuf, 0, sizeof rbuf);
        r->id = q->id;
        r->flags = 1;
        S3(NR_ioctl, listener, NOTIF_SEND, r);
      }
    } else if (fds[0].revents & (POLLHUP | POLLERR)) {
      /* Every process under the filter is gone. */
      if (told) break;
      fds[0].fd = -1;
    }
    if (fds[1].revents & POLLIN) {
      u32 info[32];
      if (S3(NR_read, signals, info, sizeof info) != sizeof info) continue;
      for (;;) {
        int st = 0;
        long pid = S4(NR_wait4, -1, &st, 1, 0);
        if (pid <= 0) break;
        if (pid != child || told) continue;
        /* The command's lines are whole before its status is: vx reads
         * the report once the shell has the status. What it left running
         * keeps no terminal or pipe of the task's open through us. */
        flush();
        told = 1;
        S3(NR_write, up[1], &st, sizeof st);
        S1(NR_close, up[1]);
        for (int fd = 0; fd < 3; fd++) S1(NR_close, fd);
        if (fds[0].fd < 0) S1(NR_exit_group, 0);
      }
    }
  }
  flush();
  S1(NR_exit_group, 0);
}

void start_c(long *sp) {
  int argc = (int)sp[0];
  char **argv = (char **)(sp + 1);
  main_(argc, argv, argv + argc + 1);
  S1(NR_exit_group, 0);
}

#if defined(__x86_64__)
__asm__(".globl _start\n_start:\n  xor %rbp, %rbp\n  mov %rsp, %rdi\n  and $-16, %rsp\n  call start_c\n");
#else
__asm__(".globl _start\n_start:\n  mov x29, #0\n  mov x0, sp\n  bl start_c\n");
#endif
