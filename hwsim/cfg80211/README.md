# Namespace-safe wireless socket cleanup

The lab's hwsim builder also builds `cfg80211.ko`. This is required for both
userspace wmediumd and the optional kernel medium; it does not change RF values,
steering policy, retry limits or convergence deadlines.

## Why it is required

The Ubuntu `7.0.0-30-generic` kernel reproduces a namespace isolation failure:
closing a generic-netlink socket in one network namespace can delete a wireless
interface owned by a still-open socket with the same port ID in another
namespace. In the 0913 prpl qualification VM, all six secondary BSS interfaces
on one extender disappeared while hostapd and the agent remained running. Their
cached BSS and client state then disagreed with the kernel.

The stock notifier iterates every radio without comparing its namespace with
the releasing socket's namespace. The patch skips foreign radios before any
scheduled-scan, interface-owner, connection-owner, management-subscription or
measurement cleanup. Cleanup for the actual owning namespace is unchanged.
This is a kernel boundary fix, not a controller workaround.
[Upstream notifier source](https://github.com/torvalds/linux/blob/v7.0/net/wireless/nl80211.c)

## Build and deployment

The normal hwsim build invokes `build-cfg80211.sh BUILD_DIRECTORY [--install]`.
It requires the running kernel's headers and exact Ubuntu source package
version. If APT no longer indexes that version, the builder retrieves its
immutable source descriptor and checksum-verified archives from Launchpad;
it does not silently substitute a newer source package. Keep `source.identity`,
`source-package.dsc`, `source.sha256`, `module.sha256` and the build log with
release evidence. This host-kernel build is separate from Yocto's shared
downloads and sstate caches.

Installation writes `updates/cfg80211.ko` and runs `depmod`. It does not unload
radios from a running lab. Installed source identity and module checksums are
retained under `/usr/share/hwsim-lab/cfg80211/`, independently of build cleanup.
Stop the lab and reboot its VM after installing over
an already-loaded stock module. Startup refuses an unpatched loaded module.
Verify both installed and loaded versions:

```sh
modinfo -F version cfg80211
cat /sys/module/cfg80211/version
```

Both must read `lab-netns-owner-1`. Do not bypass this check to package a release.
Rebuild these out-of-tree modules after a guest kernel upgrade. Hosts enforcing
module signature verification require locally trusted module signing.

## Bounded regression test

Use an **unused** hwsim PHY in the lab VM, not a radio assigned to a container.
The test creates only `ns-owner-probe`, owns it through a socket, creates a
temporary empty network namespace, closes an identically numbered socket there,
then closes the real owner. It does not alter any client or AP.

```sh
cc -Wall -Wextra -Werror test-netlink-namespace.c -o /tmp/test-netlink-namespace \
  $(pkg-config --cflags --libs libnl-3.0 libnl-genl-3.0)
sudo /tmp/test-netlink-namespace UNUSED_PHY_NUMBER
```

Expected: foreign socket close **PRESERVED**, own socket close **REMOVED**, exit
zero. Stock-kernel negative controls on both 0913 VMs deleted the interface on
the foreign close. The live test and normal room catalog remain separate gates:
passing this probe alone does not establish client convergence or release acceptance.
