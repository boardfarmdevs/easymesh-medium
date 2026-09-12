#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <usfstl/sched.h>
#include <usfstl/loop.h>

struct ingress_fixture {
    struct usfstl_scheduler *clock;
    struct usfstl_job *later;
    struct usfstl_loop_entry event;
    uint64_t delivered;
};

static uint64_t monotonic_us(void)
{
    struct timespec now;
    assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (uint64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}

static void ingress(struct usfstl_loop_entry *entry)
{
    struct ingress_fixture *fixture = entry->data;
    char marker;
    assert(read(entry->fd, &marker, 1) == 1);
    assert(fixture->clock->waiting);
    usfstl_loop_unregister(entry);
    usfstl_sched_add_job(fixture->clock, fixture->later);
}

static void delivered(struct usfstl_job *job)
{
    struct ingress_fixture *fixture = job->data;
    fixture->delivered = monotonic_us();
}

int main(void)
{
    USFSTL_SCHEDULER(clock);
    int pipefds[2];
    struct usfstl_job first = {.start = 20000, .callback = delivered};
    struct usfstl_job later = {.start = 250000, .callback = delivered};
    struct ingress_fixture fixture = {.clock = &clock, .later = &later};
    assert(pipe(pipefds) == 0);
    fixture.event = (struct usfstl_loop_entry){.fd = pipefds[0], .handler = ingress, .data = &fixture};
    first.data = &fixture;
    later.data = &fixture;
    usfstl_loop_register(&fixture.event);
    usfstl_sched_wallclock_init(&clock, 1000);
    uint64_t started = monotonic_us();
    usfstl_sched_add_job(&clock, &first);
    assert(write(pipefds[1], "x", 1) == 1);
    assert(usfstl_sched_next(&clock) == &first);
    uint64_t elapsed = fixture.delivered - started;
    usfstl_sched_del_job(&later);
    usfstl_sched_wallclock_exit(&clock);
    close(pipefds[0]);
    close(pipefds[1]);
    printf("first deadline 20000 us, later arrival 250000 us, actual %llu us\n", (unsigned long long)elapsed);
    return elapsed < 10000 || elapsed > 100000;
}
