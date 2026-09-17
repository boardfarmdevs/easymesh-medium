#define _GNU_SOURCE
#include <assert.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <netlink/netlink.h>
#include <netlink/msg.h>
#include <netlink/socket.h>

struct wmediumd { struct nl_sock *sock; };
struct usfstl_loop_entry { void *data; };
static unsigned int received;
static unsigned int calls;
static int channel[2];

@PRODUCTION@

static int raw_received(struct nl_msg *msg, void *data)
{
    (void)data;
    if (nlmsg_hdr(msg)->nlmsg_type >= NLMSG_MIN_TYPE)
        received++;
    return NL_OK;
}

static int blocking_receive(struct nl_sock *sock, struct sockaddr_nl *address,
                            unsigned char **buffer, struct ucred **credentials)
{
    (void)sock;
    (void)credentials;
    calls++;
    *buffer = calloc(1, 4096);
    assert(*buffer);
    memset(address, 0, sizeof(*address));
    address->nl_family = AF_NETLINK;
    ssize_t length = recv(channel[0], *buffer, 4096, 0);
    assert(length > 0);
    return length;
}

static void send_messages(unsigned int count, bool multipart, bool done)
{
    unsigned char payload[4096] = {0};
    size_t used = 0;
    for (unsigned int index = 0; index < count; index++) {
        struct nlmsghdr *header = (void *)(payload + used);
        header->nlmsg_len = NLMSG_HDRLEN + 4;
        header->nlmsg_type = done ? NLMSG_DONE : 42;
        header->nlmsg_flags = multipart ? NLM_F_MULTI : 0;
        used += NLMSG_ALIGN(header->nlmsg_len);
    }
    assert(send(channel[1], payload, used, 0) == (ssize_t)used);
}

static void scenario(bool disable_ack, unsigned int count, bool multipart)
{
    assert(socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, channel) == 0);
    struct wmediumd ctx = {.sock = nl_socket_alloc()};
    assert(ctx.sock);
    if (disable_ack)
        nl_socket_disable_auto_ack(ctx.sock);
    struct nl_cb *callbacks = nl_socket_get_cb(ctx.sock);
    nl_cb_set(callbacks, NL_CB_MSG_IN, NL_CB_CUSTOM, raw_received, NULL);
    nl_cb_overwrite_recv(callbacks, blocking_receive);
    struct usfstl_loop_entry event = {.data = &ctx};
    calls = received = 0;
    send_messages(count, multipart, false);
    if (multipart)
        send_messages(1, false, true);
    alarm(2);
    sock_event_cb(&event);
    alarm(0);
    unsigned int expected = disable_ack ? count : 1;
    assert(received == expected);
    assert(calls == (multipart ? 2U : 1U));
    printf("PASS auto_ack=%s multipart=%s input_messages=%u processed=%u receive_calls=%u returned_without_success_ACK\n",
           disable_ack ? "off" : "on", multipart ? "yes" : "no", count, received, calls);
    nl_cb_put(callbacks);
    nl_socket_free(ctx.sock);
    close(channel[0]);
    close(channel[1]);
}

int main(void)
{
    scenario(true, 1, false);
    scenario(true, 8, false);
    scenario(true, 8, true);
    scenario(false, 1, false);
    scenario(false, 8, false);
    return 0;
}
