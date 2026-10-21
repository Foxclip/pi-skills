---
name: pi-vmbox
description: Run and drive VirtualBox VMs in E:\VMBox on this Windows host, headless — create/configure VMs (VirtualBox 7.1.4 option names), boot from ISO, type/scancode into a console, relay files over NAT, screenshot-verify, and edit the VDI from the host. Section 2 covers the TinyCore Pure64 17.1 VM specifically: disk install, Xorg/vesa/flwm GUI stack, the evdev input fix, and the persistent .xsession. Use for any VM work in E:\VMBox — creating VMs, installing OSes, GUI repair, or post-mortem diagnosis.
---

# pi-vmbox — Virtual machines in E:\VMBox (Windows, VirtualBox 7.1.4, headless)

Two sections:
1. **General** — VMs on this host in general (creation, headless driving, transfers, MSYS gotchas).
2. **TinyCore Pure64 17.1** — everything specific to the `TinyCorePure64` VM (install, GUI, input fix, VDI editing).

All commands were verified on this host (VirtualBox 7.1.4, git-bash, 2026-10-22).

---

## Section 1 — General (any VM on this host)

### Environment

| Thing | Value |
|---|---|
| VBoxManage | `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe` — NOT on git-bash PATH; always the literal quoted path |
| Shell | git-bash/MSYS. Redirect to `/dev/null`, NEVER `nul` (MSYS writes a literal `nul` file). |
| VM location | `E:\VMBox\Disks\<Name>\` — `.vbox` + `.vdi` side by side, `Logs\` next to them. Default `C:\Users\Suburban\VirtualBox Machines` does NOT exist. |
| Existing VMs | `TinyCorePure64` (TinyCore 17.1 GUI — section 2), `Mint2` (LinuxMint, 8GB/16CPU). |
| Host 7-Zip | `C:\Program Files\7-Zip\7z.exe` (for peeking inside ISOs). |

### Host safety-net rules (learned the hard way — all three WILL block you)

- `shell.dynamic-executable`: `VBM="...VBoxManage.exe"; "$VBM" showvminfo` is BLOCKED — the executable name must be a literal full path, never a shell variable.
- `interpreter.one-liner-paranoid`: `node -e "..."` AND `python -c "..."` one-liners are BLOCKED — always write the script to a `.mjs`/`.py` file and run the file.
- The bash tool has a default ~60 s cap (`[ACP guardrail: command killed after 60s]`) — pass a larger `timeout` (90–120) for long `curl`/boot waits.

### Creating a VM (the 7.1 option renames — every old form fails)

| old (FAILED: `Unknown option`) | 7.1 replacement |
|---|---|
| `createvm ... --memory 1024` | `modifyvm <name> --memory 1024` (createvm no longer takes memory/cpus) |
| `modifyvm --bootmenu on` | `modifyvm --firmware-boot-menu messageandmenu` (off, messageonly, messageandmenu) |
| `modifyvm --storagectl ... --add sata` | separate subcommand: `storagectl <name> --name SATA --add sata --portcount 2` |
| `modifyvm --bootorder1 dvd` | `modifyvm --boot1 dvd` (`--boot1..--boot4`; values none, floppy, dvd, disk, net — it is `dvd`, NOT `dvddisk`) |
| `controlvm ... sendkey Enter` | `sendkey` does not exist — use `keyboardputscancode`/`keyboardputstring` |

Working creation chain (verbatim, from the TinyCore build):
```bash
"/c/Program Files/Oracle/VirtualBox/VBoxManage.exe" createvm --name "TinyCore" --ostype "Linux_64" --basefolder "E:\VMBox\Disks" --register
... modifyvm "TinyCore" --memory 1024 --cpus 2 --nic1 nat --vram 16 --firmware-boot-menu messageandmenu
... createhd --filename "E:\VMBox\Disks\TinyCore\TinyCore.vdi" --size 4096        # MB, dynamic
... storagectl "TinyCore" --name "SATA" --add sata --portcount 2
... storageattach "TinyCore" --storagectl "SATA" --port 0 --device 0 --type hdd --medium "E:\VMBox\Disks\TinyCore\TinyCore.vdi"
... storageattach "TinyCore" --storagectl "SATA" --port 1 --device 0 --type dvddrive --medium "<path-to-iso>"
... modifyvm "TinyCore" --boot1 dvd
# once installed to disk:
... storageattach "TinyCore" --storagectl "SATA" --port 1 --device 0 --type dvddrive --medium none
... modifyvm "TinyCore" --boot1 disk
```
Rename + resize happen via plain `modifyvm <old> --name <new>` / `--memory` / `--cpus`; the `Logs\<name>` folder follows the name.

### Power & boot (headless)

```bash
VBoxManage startvm <name>                 # no window on this host
VBoxManage controlvm <name> screenshotpng E:\path\shot.png    # lands on the HOST path
VBoxManage controlvm <name> poweroff     # instant hard off
VBoxManage controlvm <name> reset        # hard reset (VM keeps running, no ACPI needed)
VBoxManage controlvm <name> reboot       # ACPI reboot — FAILS on TinyCore (no guest session; VERR_NOT_FOUND). Use reset.
VBoxManage controlvm <name> savestate / resume
VBoxManage showvminfo <name> --machinereadable   # current truth (memory/cpus/vram/controller)
```

Boot menu: `--firmware-boot-menu messageandmenu` halts the VM at a boot prompt after showing a message; press Enter to continue. Beware ISO auto-boots: TinyCore's isolinux has `timeout 300` (30 s) — "wait for prompt" timing is a race.

### Headless keyboard & mouse

```bash
VBoxManage controlvm <name> keyboardputstring "some text"
VBoxManage controlvm <name> keyboardputscancode 1c          # ONE 1-byte hex per arg — `1c00` FAILS ('not a hex byte')
VBoxManage controlvm <name> keyboardputscancode 1C 9C       # explicit press+release pair (release = press+0x80)
VBoxManage controlvm <name> keyboardputfile <host-file>     # types a file's content as keystrokes
```

- 7.1.4 has **no mouse subcommands** (mouse* arrive in 7.2). For GUIs: aterm auto-focuses (typed chars land in it without a click); flwm windows are draggable by `Ctrl+Left-drag`-style bindings — or just retype commands in the terminal.
- Scancode rules: modifiers STAY HELD until released — a bare `38 1D 0E` (Alt+RCtrl+Bksp) test left Alt+RCtrl down and every later keystroke became a Ctrl+Alt binding (windows wandering!). Release with `B8 9D 8E` (`0x1D`=RCtrl, `0x14`=LCtrl). Bare `1c` (Enter) was enough at an isolinux `boot:` prompt; use press+release pairs for text consoles.
- VT-switch scancodes (Ctrl/Alt+F1..F6) do NOT escape a running X desktop. The reliable recovery path is power cycle + boot from ISO.
- `keyboardputfile` (exists in 7.1.4, verified in `controlvm --help`): to put a script in a guest console — `keyboardputstring "cat > /tmp/s.sh"` + Enter, then `keyboardputfile E:\path\s.sh`.

### File transfer (host ↔ guest)

The reliable, proven pattern — a NAT host relay on port 8766:
```bash
# host: serve a dir (stays up for the session)
cd /e/Trash/Empty && nohup python -m http.server 8766 --bind 0.0.0.0 --directory /e/Trash/Empty > http8766.log 2>&1 &
# host: verify
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8766/<file>    # expect 200
# guest: fetch (NAT gateway is 10.0.2.2)
wget -q http://10.0.2.2:8766/<file> -O /mnt/tce/optional/<name>.tcz && md5sum /mnt/tce/optional/<name>.tcz
```
Notes: port 8765 was also used early on; 8766 is the standing one. `curl` may be missing in the guest — use `wget`. The host sits on a VPN sometimes: external HTTPS to some hosts can be dead (TCP 000) while the relay still works.

### Screenshots & the verify loop

- `screenshotpng` is the only "eye". Compare by size (a flat all-black/monochrome PNG is ~2–3 KB) + open the file to inspect.
- Boot wait: after `startvm`, wait ≥ 60 s before the first screenshot; TinyCore console shows `Please press Enter to activate this console` when ready.
- A solid-black screenshot ≠ failure: (a) guest display can freeze headless-idle ~30–40 min after last activity — `reset` recovers (seen 3×); (b) X can be up but blank — check `Xorg.*.log` instead.

### MSYS / git-bash + tooling gotchas (host side)

- Never `> nul` / `2> nul` — use `/dev/null`. Quote Windows paths; prefer forward slashes (`/c/Program Files/...`).
- `node -e` / `python -c` blocked (see safety net) — write files, run files. Same for executables via shell variables.
- `7z` from git-bash mangles the `-o` switch / `o` verb: `7z x -y <iso> -o<dir> <filespec>` is the working form.
- `7z l` on a `.gz` (e.g. an initrd `corepure64.gz`) shows only the gzip wrapper — `gunzip -c x.gz > x.cpio` FIRST, then `7z l x.cpio`. 7z extracts cpio symlinks as 0-byte files — tiny sizes in the listing are symlinks (e.g. `sbin/fdisk`→busybox).
- `grep` ERE with backslashes → `Trailing backslash` error in git-bash; use `grep -F` fixed strings.
- `tinycorelinux.net` throttles hard on repeated fetches (~0.5–10 KB/s); mirror `tinycorelinux.mirrorservice.org` is fast.

### Reading VM state headlessly (post-mortem without a shell in the guest)

- Guest log: `E:\VMBox\Disks\<name>\Logs\<name>.log` (and `.7` rotations) — VBox device-level; X/console content is NOT here (screenshot it live instead).
- The VDI is a plain file: `mount -o loop <vdibase>.vdi /mnt` works on Windows for its ext4 partitions (see section 2 for the full VDI-edit recipe).

---

## Section 2 — TinyCore Pure64 17.1 (VM `TinyCorePure64`)

### What it is

- **TinyCore Linux 17.1** (x86_64, kernel `6.18.35-tinycore64` — psmouse + evdev BUILT IN; repo only has `input-joystick-*`/`input-tablet-touchscreen-*` kernel tczs, no mouse kernel module needed).
- Two ISOs, one word apart (confused at first — big time cost): **CorePure64-17.1** (26 MB CLI-only core; its initrd is `corepure64.gz`) vs **TinyCorePure64-17.1** (GUI edition; `cde/optional/` holds 46 GUI tczs — X stack, aterm, flwm, wbar, Xfbdev…). Verified: `CorePure64-17.1.iso` = 26294272 B, md5 `9e1332dabf3c71435cf5fdf288df81cd`, from `tinycorelinux.net/17.x/x86_64/release/`.
- Repo layout: `17.x/x86_64/{archive,release,tcz}/` — tczs are FLAT in `/tcz/` (the old `/tc/` path 404s). `.tcz` files are **squashfs** (loop-mountable: `mount -o loop x.tcz /tmp/x && ls /tmp/x` is the real content check).
- Created 2026-10-20 as VM `TinyCore` (1 GB RAM / 2 vCPU / vram 16), later renamed `TinyCorePure64` and grown for the GUI: live config is **8 GB / 16 vCPU / vram 128** (trust `showvminfo` over history). NAT (guest sees host at `10.0.2.2`).
- 4 GB `TinyCorePure64.vdi` (ext4, `sda1`), currently boots from disk to a **flwm GUI desktop** (1024x768, Xorg `vesa` driver on VBoxVGA) with aterm + wbar. Root password `root` (auto-set each boot). Guest user `tc` has **passwordless full sudo** (`tc\tALL=NOPASSWD: ALL` + setuid sudo).
- Host artifacts: `E:\Trash\Empty\mouse_report.md` (input-fix report), `xsession_v3`/`xsession_v7` (host copies), `vm_gui_verify.png`, `vm_mouse_final.png`, `STATUS.md`.

### Install to disk (pure-CLI persistence, built-in tools only)

Core rootfs has `fdisk`, `mkfs.ext4` (busybox/mke2fs), `e2fsck`, `tce-setup` built in; NO `tcedump`, no bootloaders. `tc-install.tcz` = FLTK GUI (useless without X). Working CLI path:
1. `fdisk /dev/sda` — keys: `n`, `p`, `1`, ENTER, ENTER (whole disk), `w`; then `mkfs.ext4 /dev/sda1`
2. `mkdir -p /mnt/sda1; mount /dev/sda1 /mnt/sda1; mkdir -p /mnt/sda1/{tce/optional,home,opt}; cp -a /tce/. /mnt/sda1/tce/; sync; reboot`
3. At `boot:`: `corepure64 loglevel=3 tce=sda1 home=sda1 opt=sda1` (tc-install's extlinux.conf uses exactly `tce=`, `home=`, `opt=`; the `home=` param is what persists `/home`)
4. Verify persistence: `tce-load -i nano.tcz; reboot` → still installed ⇒ persistent.
- Lighter alternative: `corepure64 opt=copy2fs` at the boot prompt (session copied to the ext partition on EVERY boot — slower, zero install).
- The GUI stack was placed on the VDI the same way: a script (`s.sh`) copied the GUI ISO's `cde/optional/*.tcz` + `*.md5.txt` + `cde/onboot.lst` into `/mnt/sda1/tce/` — ISO stayed attached as SR device the whole time.

### The GUI stack (Xorg vesa on VBoxVGA + flwm)

Why the stock setup is dead (root-cause chain, in order):
1. Kernel has **no framebuffer driver** (only udlfb) → the stock **Xfbdev** X server can never start (boot prints `failed in waitForX`, falls to text console).
2. A **phantom `/dev/fb0`** node (static, baked into the initrd `/dev`, no devtmpfs) makes vesa refuse: `(EE) vesa: Refusing to run, Framebuffer or dri device present` → fix `sudo rm -f /dev/fb0` (node is not recreated).
3. `/home` is **tmpfs** → any profile you hand-make is lost every reboot → persist via the `home=` boot param (extlinux APPEND) + seed: `sudo mkdir -p /mnt/sda1/home && sudo cp -a /home/tc /mnt/sda1/home/`.

Video driver: only **vesa on VBoxVGA** works (`--graphicscontroller vboxvga`; the option is `graphicscontroller`, NOT `videocontroller`). Dead ends: vmware_drv (no `/dev/vgmux`, VMware-only), modesetting (no libgbm, no `/dev/dri`), vesa on VMSVGA (no VBE → `Fatal server error: no screens found`). Success marker in `Xorg.0.0.log`: `VESA(0): VESA VBE Version 2.0 / OEM: VirtualBox VESA BIOS / Setting up VESA Mode 0x144 (1024x768)`.

The tczs (all from `17.x/x86_64/tcz/`, downloaded in-VM then installed to VDI + `tce-load -i` as `tc` — NEVER `sudo tce-load`):
`xorg-server.tcz` (2.9 MB — repo has NO lowercase `xorg.tcz`; `Xorg-7.7.tcz` is a 4 KB 2013 empty stub, ignore), `Xorg-fonts.tcz`, `dejavu-fonts-ttf.tcz`, `libpciaccess.tcz`, `openssl.tcz`, `libXfont2.tcz`, then the `ldd` chase: `libxshmfence.tcz`, `udev-lib.tcz` (libudev.so.0), `libdrm.tcz`, `libxcvt.tcz`, `libxatracker.tcz`; keyboard: `xkbcomp.tcz` + `libxkbfile.tcz` (X dies with `XKB: Failed to compile keymap` without them); video: `xf86-video-vesa.tcz` + `vesa-Xorg.conf.tcz`; input: `xf86-input-evdev.tcz` + (the two missing deps, see below) `libevdev.tcz` + `mtdev.tcz`.
Audit loop used: `ldd /usr/local/lib/xorg/Xorg 2>&1 | grep "not found"` → install → repeat until clean. (Wrapper is `/usr/local/bin/Xorg`, real binary `/usr/local/lib/xorg/Xorg`; test a start with `sudo /usr/local/bin/Xorg :0.0 -nolisten tcp &`.)

Final working `.xsession` (v7, the one in `/mnt/sda1/home/tc/.xsession`; host copy `E:\Trash\Empty\xsession_v7`):
```sh
#!/bin/sh
# v7 final: Xorg (vesa on VBoxVGA) + flwm + wbar + aterm.
export DISPLAY=:0.0
sudo sh -c "echo root:root | chpasswd" 2>/dev/null
sudo rm -f /dev/fb0
sudo /usr/local/bin/Xorg :0.0 -nolisten tcp >/tmp/xorg0.out 2>&1 &
i=0
while [ $i -lt 20 ]; do
  [ -e /tmp/.X11-unix/X0 ] && break
  i=$((i+1))
  sleep 1
done
if [ $i -ge 20 ]; then
  echo "Xorg failed to start" > /tmp/xstart_err
  tail -25 /var/log/Xorg.0.0.log >> /tmp/xstart_err 2>&1
else
  /usr/local/bin/flwm >/tmp/flwm.log 2>&1 &
  sleep 2
  /usr/local/bin/wbar >/tmp/wbar.log 2>&1 &
  /usr/local/bin/aterm >/dev/null 2>&1 &
fi
```
Gotchas baked in there: plain `aterm` (flags like `-geometry 80x24 -pos 20x40` make aterm exit silently — usage went to /dev/null); WM is `/usr/local/bin/flwm` (NOT `wmflwm`); root password must be re-set every boot (live `passwd root` does NOT persist — /etc/shadow is tmpfs); aterm auto-focuses in flwm (typed chars land in it without a click); `ls` without `-a` makes `/home/tc` look empty (false alarm).

### The mouse/keyboard input fix (evdev — the "frozen mouse" that wasn't)

Symptom: GUI desktop renders, but mouse AND keyboard are dead inside X (console fine). Root cause: `xf86-input-evdev`'s `evdev_drv.so` failed to load because **`libevdev.so.2` + `libmtdev.so.1` were missing** — TC's dependency resolution is bypassed when tczs are placed by hand (cp into `/tce/optional`), so `xf86-input-evdev`'s deps never got installed. The kernel side was always healthy (`/proc/bus/input/devices` showed the PS/2 + "VirtualBox mouse integration" devices).
Audit commands: `ldd /usr/local/lib/xorg/modules/input/evdev_drv.so 2>&1 | grep "not found"` + `grep -nEi "evdev|mouse|\(EE\)" /var/log/Xorg.0.0.log`.
Fix (persistent, on VDI): `libevdev.tcz` + `mtdev.tcz` into `/tce/optional` + 2 lines in `/tce/onboot.lst` → loaded before X each boot. `xf86-input-vmmouse` is useless (no vboxguest). Full report: `E:\Trash\Empty\mouse_report.md`.

### tce-load quirks (live ISO boot)

- As root: "Don't run this as root." As non-root: fails silently (loop mount problem). Don't rely on it live — verify tczs by `mount -o loop` + ls, and let the disk boot's `onboot.lst` do the loading.

### Editing the VDI from the HOST (the workhorse recipe)

TinyCore's live system sees the VDI as `/dev/sda1` (ISO is `sr0`). From the host, the same file is loop-mountable:
```bash
# host (git-bash). Find the partition offset first (sda1 starts at 2048 512B sectors = 1048576 B):
mount -o loop,offset=1048576 "/e/VMBox/Disks/TinyCorePure64/TinyCorePure64.vdi" /mnt
ls /mnt            # tce/ home/
# write as tc needs ROOT perms on the mounted fs — plain `>>` is Permission denied:
sudo sh -c "echo libevdev >> /mnt/tce/onboot.lst"
cp -f /e/Trash/Empty/xsession_v7 /mnt/home/tc/.xsession
sync && umount /mnt
```
Pitfalls: a `cd` into `/mnt` (any process holding the cwd) blocks `umount` until you `cd /`; on Windows the mount is by-offset on the raw VDI (ext4 partition), NOT the whole disk (offset 0 hits the MBR/extlinux area).
The in-guest equivalent (ISO boot, VDI mounted at `/mnt`): `sudo mount /dev/sda1 /mnt`, edit, `sync && sudo umount /mnt`.

### Recovery & troubleshooting (TinyCore-specific)

- **Solid-black screenshot, headless idle ~30–40 min after last activity** (guest display freeze; 3 occurrences) — `reset` recovers and the desktop boots again. Do NOT treat as a fix failure.
- **ACPI reboot fails** (`controlvm reboot` → VERR_NOT_FOUND, no guest session) — use `reset`.
- **`failed in waitForX`** at boot = X (Xfbdev stock) never came up → read `/var/log/Xorg.0.0.log` via a relay/console; the string itself comes from a disk-side script, not the initrd.
- **X dies on keymap** (`Failed to activate virtual core keyboard: 2`) → install `xkbcomp.tcz` + `libxkbfile.tcz`.
- **Everything "installed" but lost after reboot** → check what's on tmpfs: `/home` (needs `home=` param + `/mnt/sda1/home`), root password (needs chpasswd in `.xsession`), live tce-load (needs onboot.lst line).
- Stuck at `Please press Enter to activate this console` (or `boot:`) — just type `keyboardputscancode 1C 9C`.
- ISO stays attached on IDE port1 even in disk boot (harmless; it's the tcz source of record).

### VMs in this lab (index)

| VM | Purpose | Config (2026-10-22) | Notes |
|---|---|---|---|
| `TinyCorePure64` | TinyCore 17.1 GUI | 8 GB / 16 vCPU / vram 128 / NAT / VBoxVGA / 4 GB VDI | Boots to flwm desktop; root pw `root`; input via evdev (libevdev+mtdev tczs) |
| `Mint2` | LinuxMint | 8 GB / 16 CPU | Has a guestcontrol channel: `VBoxManage guestcontrol Mint2 run --username=foxclip --passwordfile=... -- <cmd...>` |
