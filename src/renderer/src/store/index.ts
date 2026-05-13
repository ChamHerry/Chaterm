import { defineStore } from 'pinia'

export const userInfoStore = defineStore('userInfo', {
  state: () => ({
    userInfo: {
      name: '',
      email: '',
      avatar: '',
      registrationType: '',
      token: '',
      uid: 0,
      username: '',
      mobile: ''
    },
    stashMenu: ''
  }),
  actions: {
    updateInfo(info) {
      this.userInfo = info
    },
    updateStashMenu(info) {
      this.stashMenu = info
    },
    deleteInfo() {
      this.userInfo = {
        name: '',
        email: '',
        avatar: '',
        registrationType: '',
        token: '',
        uid: 0,
        username: '',
        mobile: ''
      }
    }
  },
  getters: {},
  persist: true
})
