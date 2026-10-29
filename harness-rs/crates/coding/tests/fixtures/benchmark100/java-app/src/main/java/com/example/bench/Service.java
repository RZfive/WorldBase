package com.example.bench;

import java.util.List;

public class Service {
    public static final int MAX_RETRIES = 3;
    private String name;

    public Service(String name) {
        this.name = name;
    }

    public String greet() {
        return "hello " + name;
    }

    public void notifyHelper() {
        new Helper().ping();
    }

    private int retries() {
        return MAX_RETRIES;
    }

    public static class Helper {
        public void ping() {
        }
    }
}

interface Contract {
    int MAX = 10;
    void run();
}
