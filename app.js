App({
  onLaunch() {
    console.log('[app] onLaunch');
    this.globalData = {
      locName: '北京',
      locLat: 39.9042,
      locLon: 116.4074
    };
  }
});
