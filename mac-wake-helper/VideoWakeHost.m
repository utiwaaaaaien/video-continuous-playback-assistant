// Video Continuous Playback Assistant: a fixed-protocol, user-scoped native host.
// Uses public IOKit power APIs; no shell execution, network, or settings changes.
#import <Foundation/Foundation.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <ApplicationServices/ApplicationServices.h>
#import <mach-o/dyld.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <sys/stat.h>

static NSString *const HostName = @"org.codex.video_continuous_playback";
static IOPMAssertionID displayID = kIOPMNullAssertionID;
static IOPMAssertionID systemID = kIOPMNullAssertionID;
static IOPMAssertionID activityID = kIOPMNullAssertionID;
static volatile sig_atomic_t stopping = 0;
static double expiresAt = 0;
static BOOL protected = NO;
static double now(void) { return NSProcessInfo.processInfo.systemUptime; }
static void stopSignal(int value) { stopping = 1; }
static void releasePower(void) {
  IOPMAssertionID *ids[] = {&displayID, &systemID, &activityID};
  for (int i=0;i<3;i++) {if (*ids[i] != kIOPMNullAssertionID) IOPMAssertionRelease(*ids[i]); *ids[i] = kIOPMNullAssertionID;}
  protected = NO; expiresAt = 0;
}
static BOOL locked(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  return !session || ![session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] || [session[@"CGSSessionScreenIsLocked"] boolValue];
}
static BOOL hold(CFStringRef type, IOPMAssertionID *identifier, double ttl) {
  if (*identifier == kIOPMNullAssertionID) {
    return IOPMAssertionCreateWithDescription(type, CFSTR("Video Continuous Playback Assistant"),
      CFSTR("User enabled protection while video plays"), NULL, NULL, ttl,
      kIOPMAssertionTimeoutActionRelease, identifier) == kIOReturnSuccess;
  }
  if (IOPMAssertionSetProperty(*identifier, kIOPMAssertionTimeoutKey, (__bridge CFNumberRef)@(ttl)) == kIOReturnSuccess) return YES;
  *identifier = kIOPMNullAssertionID;
  return hold(type, identifier, ttl);
}
static BOOL acquire(double ttl) {
  if (locked()) {releasePower(); return NO;}
  BOOL ok = hold(kIOPMAssertionTypePreventUserIdleDisplaySleep, &displayID, ttl) &&
            hold(kIOPMAssertionTypePreventUserIdleSystemSleep, &systemID, ttl);
  if (ok) ok = IOPMAssertionDeclareUserActivity(CFSTR("Video Continuous Playback Assistant"), kIOPMUserActiveLocal, &activityID) == kIOReturnSuccess;
  if (!ok) {releasePower(); return NO;}
  // Independent monotonic watchdog below also releases the activity declaration.
  expiresAt = now() + ttl; protected = YES; return YES;
}
static NSString *manifestPath(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:[@"Library/Application Support/Google/Chrome/NativeMessagingHosts/" stringByAppendingString:[HostName stringByAppendingString:@".json"]]];
}
static int install(NSString *extensionID) {
  if (![extensionID isKindOfClass:NSString.class] || ![[NSPredicate predicateWithFormat:@"SELF MATCHES %@", @"[a-p]{32}"] evaluateWithObject:extensionID]) {fprintf(stderr,"Expected Chrome extension ID (32 letters a-p).\n"); return 2;}
  uint32_t size=0; _NSGetExecutablePath(NULL,&size); char *buffer=malloc(size); if (_NSGetExecutablePath(buffer,&size)) {free(buffer); return 2;}
  NSString *binary=[[@(buffer) stringByStandardizingPath] stringByResolvingSymlinksInPath]; free(buffer);
  NSError *error=nil;
  NSString *destination=[NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Video Continuous Playback Assistant/VideoWakeHost"];
  NSFileManager *manager=NSFileManager.defaultManager;
  if (![manager createDirectoryAtPath:destination.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:&error]) {fprintf(stderr,"Install directory failed: %s\n",error.description.UTF8String); return 1;}
  if (![binary isEqualToString:destination]) {
    NSData *executable=[NSData dataWithContentsOfFile:binary options:0 error:&error];
    if (!executable || ![executable writeToFile:destination options:NSDataWritingAtomic error:&error]) {fprintf(stderr,"Install binary failed: %s\n",error.description.UTF8String); return 1;}
  }
  if (chmod(destination.fileSystemRepresentation,0755)!=0) {perror("Install permissions"); return 1;}
  NSDictionary *manifest=@{@"name":HostName,@"description":@"Mac wake protection for Video Continuous Playback Assistant",@"path":destination,@"type":@"stdio",@"allowed_origins":@[[NSString stringWithFormat:@"chrome-extension://%@/",extensionID]]};
  [manager createDirectoryAtPath:manifestPath().stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:&error];
  NSData *data=[NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingPrettyPrinted error:&error];
  if (error || ![data writeToFile:manifestPath() options:NSDataWritingAtomic error:&error]) {fprintf(stderr,"Install failed: %s\n",error.description.UTF8String); return 1;}
  chmod(manifestPath().fileSystemRepresentation,0600);
  printf("Installed: %s\n",manifestPath().UTF8String); return 0;
}
static BOOL output(NSDictionary *object) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:object options:0 error:nil]; uint32_t size=(uint32_t)data.length;
  if (fwrite(&size,4,1,stdout)!=1 || fwrite(data.bytes,1,size,stdout)!=size) return NO;
  return fflush(stdout)==0;
}
int main(int argc,char **argv) {
 @autoreleasepool {
  if (argc==3 && strcmp(argv[1],"--install")==0) return install(@(argv[2]));
  if (argc==2 && strcmp(argv[1],"--status")==0) {NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary()); NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"locked":@(locked()),@"sessionAvailable":@(session!=nil),@"onConsole":session[(__bridge NSString *)kCGSessionOnConsoleKey] ?: @NO,@"lockFlag":session[@"CGSSessionScreenIsLocked"] ?: @NO,@"version":@"2.1.0"} options:0 error:nil]; puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); return 0;}
  NSData *config=[NSData dataWithContentsOfFile:manifestPath()];
  NSDictionary *manifest=config?[NSJSONSerialization JSONObjectWithData:config options:0 error:nil]:nil;
  if (argc<2 || ![manifest[@"allowed_origins"] containsObject:@(argv[1])]) {fprintf(stderr,"Unregistered extension origin.\n"); return 3;}
  signal(SIGPIPE,SIG_IGN); signal(SIGTERM,stopSignal); signal(SIGINT,stopSignal);
  NSMutableData *buffer=[NSMutableData data];
  while (!stopping) { @autoreleasepool {
    if (protected && (now() >= expiresAt || locked())) releasePower();
    struct pollfd descriptor={STDIN_FILENO,POLLIN,0}; int ready=poll(&descriptor,1,1000);
    if (ready<0) {if(errno==EINTR) continue; break;}
    if (!ready) continue;
    if (descriptor.revents & (POLLIN|POLLHUP)) {
      unsigned char bytes[4096]; ssize_t count=read(STDIN_FILENO,bytes,sizeof(bytes)); if(count<=0) break;
      [buffer appendBytes:bytes length:(NSUInteger)count];
      while (buffer.length>=4) {
        uint32_t length=0; memcpy(&length,buffer.bytes,4); if(!length || length>4096) {stopping=1; break;}
        if(buffer.length<length+4) break;
        NSData *frame=[buffer subdataWithRange:NSMakeRange(4,length)]; [buffer replaceBytesInRange:NSMakeRange(0,length+4) withBytes:NULL length:0];
        id input=[NSJSONSerialization JSONObjectWithData:frame options:0 error:nil];
        if (![input isKindOfClass:NSDictionary.class]) {stopping=1; break;}
        NSNumber *identifier=[input[@"id"] isKindOfClass:NSNumber.class]?input[@"id"]:@0;
        BOOL valid=[input[@"type"] isEqual:@"set-awake"] && [input[@"active"] isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)input[@"active"])==CFBooleanGetTypeID();
        if(!valid) {releasePower(); if(!output(@{@"id":identifier,@"ok":@NO,@"active":@NO,@"reason":@"invalid-command"})) stopping=1; continue;}
        BOOL isLocked=locked(); BOOL active=[input[@"active"] boolValue];
        double ttl=[input[@"ttl"] isKindOfClass:NSNumber.class]?[input[@"ttl"] doubleValue]:75;
        if(!isfinite(ttl)) ttl=75; ttl=fmax(1,fmin(90,ttl));
        BOOL ok=YES;
        if(active) ok=acquire(ttl); else releasePower();
        if(!output(@{@"id":identifier,@"ok":@(ok),@"active":@(protected),@"reason":isLocked?@"locked":ok?@"ready":@"power-unavailable",@"version":@"2.1.0"})) stopping=1;
      }
    } else if(descriptor.revents & (POLLERR|POLLNVAL)) break;
  }}
  releasePower(); return 0;
 }
}
