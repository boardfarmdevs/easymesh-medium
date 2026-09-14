#define _GNU_SOURCE
#include <errno.h>
#include <linux/nl80211.h>
#include <net/if.h>
#include <netlink/genl/ctrl.h>
#include <netlink/genl/genl.h>
#include <netlink/msg.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/random.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    unsigned int port;
    const char *name = "ns-owner-probe";
    struct nl_sock *owner = nl_socket_alloc();
    struct nl_msg *message = nlmsg_alloc();
    int result = 0;
    int status;
    if (argc != 2 || !owner || !message || if_nametoindex(name) ||
        getrandom(&port, sizeof(port), 0) != sizeof(port))
        return 2;
    port |= 0x80000000;
    nl_socket_set_local_port(owner, port);
    if (genl_connect(owner))
        return 2;
    int family = genl_ctrl_resolve(owner, "nl80211");
    if (family < 0)
        return 2;
    genlmsg_put(message, NL_AUTO_PORT, NL_AUTO_SEQ, family, 0, 0,
                NL80211_CMD_NEW_INTERFACE, 0);
    nla_put_u32(message, NL80211_ATTR_WIPHY, strtoul(argv[1], NULL, 10));
    nla_put_string(message, NL80211_ATTR_IFNAME, name);
    nla_put_u32(message, NL80211_ATTR_IFTYPE, NL80211_IFTYPE_STATION);
    nla_put_flag(message, NL80211_ATTR_SOCKET_OWNER);
    if (nl_send_auto(owner, message) < 0 || (result = nl_wait_for_ack(owner))) {
        fprintf(stderr, "cannot create owned probe: %s\n", nl_geterror(result));
        return 2;
    }
    nlmsg_free(message);
    if (!if_nametoindex(name))
        return 2;
    pid_t child = fork();
    if (child == 0) {
        if (unshare(CLONE_NEWNET))
            _exit(2);
        int socket_fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_GENERIC);
        struct sockaddr_nl address = {.nl_family = AF_NETLINK, .nl_pid = port};
        if (socket_fd < 0 || bind(socket_fd, (void *)&address, sizeof(address)))
            _exit(2);
        close(socket_fd);
        _exit(0);
    }
    if (child < 0 || waitpid(child, &status, 0) != child || status != 0)
        return 2;
    usleep(500000);
    int survived = if_nametoindex(name) != 0;
    printf("same-port socket closed in unrelated netns; owned interface %s\n",
           survived ? "PRESERVED" : "INCORRECTLY DELETED");
    nl_socket_free(owner);
    usleep(500000);
    int cleaned = if_nametoindex(name) == 0;
    printf("owning socket closed; owned interface %s\n",
           cleaned ? "REMOVED" : "INCORRECTLY RETAINED");
    return survived && cleaned ? 0 : 1;
}
