#include <errno.h>
#include <linux/genetlink.h>
#include <linux/netlink.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static unsigned int failures;

static void query(bool request_ack, bool invalid, uint32_t sequence)
{
    int descriptor = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
    if (descriptor < 0) {
        perror("socket");
        exit(2);
    }
    struct sockaddr_nl address = {.nl_family = AF_NETLINK};
    if (bind(descriptor, (struct sockaddr *)&address, sizeof(address))) {
        perror("bind");
        exit(2);
    }
    unsigned char request[128] = {0};
    struct nlmsghdr *header = (void *)request;
    header->nlmsg_len = NLMSG_HDRLEN + GENL_HDRLEN;
    header->nlmsg_type = GENL_ID_CTRL;
    header->nlmsg_flags = NLM_F_REQUEST | (request_ack ? NLM_F_ACK : 0);
    header->nlmsg_seq = sequence;
    struct genlmsghdr *generic = NLMSG_DATA(header);
    generic->cmd = CTRL_CMD_GETFAMILY;
    generic->version = 1;
    if (!invalid) {
        struct nlattr *attribute = (void *)(request + header->nlmsg_len);
        attribute->nla_type = CTRL_ATTR_FAMILY_ID;
        attribute->nla_len = NLA_HDRLEN + sizeof(uint16_t);
        uint16_t identifier = GENL_ID_CTRL;
        memcpy((unsigned char *)attribute + NLA_HDRLEN, &identifier, sizeof(identifier));
        header->nlmsg_len += NLA_ALIGN(attribute->nla_len);
    }
    if (sendto(descriptor, request, header->nlmsg_len, 0,
               (struct sockaddr *)&address, sizeof(address)) != header->nlmsg_len) {
        perror("sendto");
        exit(2);
    }
    unsigned int positive = 0, negative = 0, data = 0;
    int last_error = 0;
    for (unsigned int attempt = 0; attempt < 8; attempt++) {
        struct pollfd pending = {.fd = descriptor, .events = POLLIN};
        int ready = poll(&pending, 1, attempt ? 100 : 1000);
        if (ready < 0) {
            perror("poll");
            exit(2);
        }
        if (!ready)
            break;
        unsigned char response[8192];
        struct sockaddr_nl sender = {0};
        socklen_t sender_length = sizeof(sender);
        ssize_t length = recvfrom(descriptor, response, sizeof(response), 0,
                                  (struct sockaddr *)&sender, &sender_length);
        if (length < 0 || sender.nl_pid) {
            fprintf(stderr, "unexpected receive or sender\n");
            exit(2);
        }
        for (struct nlmsghdr *reply = (void *)response; NLMSG_OK(reply, length);
             reply = NLMSG_NEXT(reply, length)) {
            if (reply->nlmsg_seq != sequence) {
                fprintf(stderr, "unexpected response sequence\n");
                exit(2);
            }
            if (reply->nlmsg_type == NLMSG_ERROR) {
                struct nlmsgerr *error = NLMSG_DATA(reply);
                last_error = error->error;
                if (error->error)
                    negative++;
                else
                    positive++;
            } else if (reply->nlmsg_type == GENL_ID_CTRL) {
                data++;
            } else {
                fprintf(stderr, "unexpected response type\n");
                exit(2);
            }
        }
    }
    bool passed = invalid ? negative == 1 && last_error == -EINVAL && !data && !positive
                          : data == 1 && positive == (unsigned int)request_ack && !negative;
    failures += !passed;
    printf("%s flags=%s query=%s data=%u success_ack=%u negative=%u errno=%d\n",
           passed ? "PASS" : "FAIL", request_ack ? "REQUEST|ACK" : "REQUEST",
           invalid ? "missing-attributes" : "existing-control-family-id",
           data, positive, negative, last_error);
    close(descriptor);
}

int main(void)
{
    query(true, false, 1);
    query(false, false, 2);
    query(true, true, 3);
    query(false, true, 4);
    return failures ? 1 : 0;
}
