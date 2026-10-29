package service

import (
	"fmt"
	alias "example.com/support"
)

type User struct {
	Name string
}

type Greeter interface {
	Greet() string
}

type ID = string

const MaxRetries = 3

var defaultTimeout = 30

func NewUser(name string) User {
	return User{Name: name}
}

func (u User) Greet() string {
	return fmt.Sprintf("hello %s", u.Name)
}

func (u *User) rename(name string) {
	u.Name = name
}

func describe(user User) string {
	return user.Greet()
}

func helper() {}

var _ = alias.Version
