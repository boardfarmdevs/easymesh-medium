#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <syslog.h>
#include <unistd.h>
#include <netlink/netlink.h>
#include <netlink/msg.h>
#include <netlink/socket.h>
#include <netlink/genl/genl.h>
#include <netlink/genl/ctrl.h>

enum { CLIENT_NETLINK, CLIENT_VHOST_USER, CLIENT_API_SOCK };
enum { HWSIM_VQ_RX = 0, WMEDIUMD_MSG_NETLINK = 1 };
struct client { int type; void *dev; struct { int fd; } loop; };
struct wmediumd_message_header { int type; size_t data_len; };
struct wmediumd { struct nl_sock *sock; struct nl_cb *cb; int family_id; };
static unsigned int failures;
static unsigned int checks;
static unsigned int sends;
static unsigned int errors;
static unsigned int acknowledgments;
static unsigned short sent_flags;
static unsigned int sent_sequence;
static unsigned char sent_command;
static unsigned char saved_message[4096];
static size_t saved_length;
static int injected_error;
static int recv_round;
static bool family_resolved;

static void check(bool condition, const char *name)
{
    checks++;
    failures += !condition;
    printf("%s %s\n", condition ? "PASS" : "FAIL", name);
}

#define w_logf(...) ((void)0)
static void usfstl_vhost_user_dev_notify(void *device, int queue, void *data, size_t length)
{
    (void)device; (void)queue; (void)data; (void)length;
    abort();
}
static void wmediumd_wait_for_client_ack(struct wmediumd *ctx, struct client *client)
{
    (void)ctx; (void)client;
    abort();
}
static int fixture_connect(struct nl_sock *sock)
{
    (void)sock;
    return 0;
}
static int fixture_buffer(struct nl_sock *sock, int receive, int transmit)
{
    (void)sock;
    assert(receive == 4 * 1024 * 1024 && transmit == 0);
    return 0;
}
static int fixture_resolve(struct nl_sock *sock, const char *name)
{
    (void)sock;
    assert(strcmp(name, "MAC80211_HWSIM") == 0);
    family_resolved = true;
    return 42;
}
static int process_messages_cb(struct nl_msg *msg, void *arg)
{
    (void)msg; (void)arg;
    return NL_OK;
}
static int nl_err_cb(struct sockaddr_nl *address, struct nlmsgerr *error, void *arg)
{
    (void)address; (void)arg;
    assert(error->error == injected_error);
    assert(error->msg.nlmsg_seq == sent_sequence);
    errors++;
    return NL_SKIP;
}

#define genl_connect fixture_connect
#define nl_socket_set_buffer_size fixture_buffer
#define genl_ctrl_resolve fixture_resolve
@PRODUCTION@
#undef genl_connect
#undef nl_socket_set_buffer_size
#undef genl_ctrl_resolve

static int record_send(struct nl_sock *sock, struct nl_msg *msg)
{
    (void)sock;
    struct nlmsghdr *header = nlmsg_hdr(msg);
    struct genlmsghdr *generic = nlmsg_data(header);
    assert(family_resolved && header->nlmsg_len <= sizeof(saved_message));
    sent_flags = header->nlmsg_flags;
    sent_sequence = header->nlmsg_seq;
    sent_command = generic->cmd;
    saved_length = header->nlmsg_len;
    memcpy(saved_message, header, saved_length);
    sends++;
    return header->nlmsg_len;
}

static int ack_received(struct nl_msg *msg, void *arg)
{
    (void)msg; (void)arg;
    acknowledgments++;
    return NL_OK;
}

static int fake_receive(struct nl_sock *sock, struct sockaddr_nl *address,
                        unsigned char **data, struct ucred **credentials)
{
    (void)sock;
    (void)credentials;
    if (recv_round++)
        return -NLE_AGAIN;
    memset(address, 0, sizeof(*address));
    address->nl_family = AF_NETLINK;
    size_t length = NLMSG_HDRLEN + sizeof(int) + saved_length;
    *data = calloc(1, length);
    assert(*data);
    struct nlmsghdr *header = (void *)*data;
    header->nlmsg_len = length;
    header->nlmsg_type = NLMSG_ERROR;
    header->nlmsg_seq = sent_sequence;
    struct nlmsgerr *error = NLMSG_DATA(header);
    error->error = injected_error;
    memcpy(&error->msg, saved_message, saved_length);
    return length;
}

int main(void)
{
    struct wmediumd ctx = {0};
    struct client client = {.type = CLIENT_NETLINK};
    assert(init_netlink(&ctx) == 0);
    nl_cb_overwrite_send(ctx.cb, record_send);
    nl_cb_overwrite_recv(ctx.cb, fake_receive);
    nl_cb_set(ctx.cb, NL_CB_ACK, NL_CB_CUSTOM, ack_received, NULL);
    nl_socket_disable_seq_check(ctx.sock);
    unsigned int prior_sequence = 0;
    const unsigned char commands[] = {2, 3, 1};
    for (size_t index = 0; index < sizeof(commands); index++) {
        struct nl_msg *msg = nlmsg_alloc();
        assert(msg);
        assert(genlmsg_put(msg, NL_AUTO_PORT, NL_AUTO_SEQ, ctx.family_id,
                           0, NLM_F_REQUEST, commands[index], 1));
        assert(nla_put_u32(msg, 99, 0x12345678) == 0);
        wmediumd_send_to_client(&ctx, &client, msg);
        printf("OBSERVED command=%u flags=0x%x sequence=%u\n", sent_command, sent_flags, sent_sequence);
        check(!(sent_flags & NLM_F_ACK), "no unnecessary success ACK requested");
        check((sent_flags & NLM_F_REQUEST) != 0, "kernel request semantics preserved");
        check(sent_sequence && sent_sequence != prior_sequence, "automatic unique correlation sequence preserved");
        check(sent_command == commands[index], "generic command preserved");
        struct nlattr *attribute = genlmsg_attrdata(nlmsg_data(nlmsg_hdr(msg)), 0);
        check(nla_get_u32(attribute) == 0x12345678, "payload preserved");
        prior_sequence = sent_sequence;
        nlmsg_free(msg);
    }
    injected_error = -EINVAL;
    recv_round = 0;
    int result = nl_recvmsgs_default(ctx.sock);
    check(result == 0 && errors == 1, "negative kernel reply still dispatched to error callback");
    injected_error = -ENOBUFS;
    recv_round = 0;
    result = nl_recvmsgs_default(ctx.sock);
    check(result == 0 && errors == 2, "negative ENOBUFS reply remains visible");
    injected_error = 0;
    recv_round = 0;
    result = nl_recvmsgs_default(ctx.sock);
    check(result == 0 && acknowledgments == 1 && errors == 2, "explicit success reply remains accepted if present");
    check(sends == 3, "all requested frames still submitted");
    nl_socket_free(ctx.sock);
    nl_cb_put(ctx.cb);
    printf("RESULT %u/%u PASS\n", checks - failures, checks);
    return failures ? 1 : 0;
}
